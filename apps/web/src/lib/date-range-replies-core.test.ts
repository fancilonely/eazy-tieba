import { describe, expect, test } from "bun:test";
import {
	AsyncBoundedQueue,
	abortableDelay,
	collectPages,
	completionStatus,
	createFirstFloorResolver,
	createReplyClassifier,
	type DateReplyPost,
	defaultDateRange,
	type FailedPage,
	filterDate,
	isAbortError,
	locatePages,
	maxEndDateForStart,
	migrateHistoricalTask,
	type PageCache,
	PageRequestError,
	pageFingerprint,
	pageMappingDrifted,
	pageTimeBounds,
	RequestScheduler,
	runClassificationPool,
	runStreamingReplyPipeline,
	uniquePosts,
	validateDateRange,
	withExponentialRetry,
} from "./date-range-replies-core.ts";

const DAY_SECONDS = 86_400;
const NEWEST_SECONDS = Date.parse("2025-12-31T12:00:00+08:00") / 1_000;

function postForPage(
	page: number,
	id = String(page),
	options: Partial<DateReplyPost> = {},
): DateReplyPost {
	return {
		forumId: 1,
		forumName: "测试吧",
		title: `第 ${page} 页`,
		threadId: `thread-${id}`,
		postId: `post-${id}`,
		cid: `cid-${id}`,
		createTime: NEWEST_SECONDS - (page - 1) * DAY_SECONDS,
		affiliated: true,
		content: `content-${id}`,
		...options,
	};
}

function memoryCache(initial: Record<number, DateReplyPost[]> = {}) {
	const pages = new Map<number, DateReplyPost[]>(
		Object.entries(initial).map(([page, posts]) => [Number(page), posts]),
	);
	const failures = new Map<number, FailedPage>();
	const cache: PageCache = {
		get: async (page) => pages.get(page),
		put: async (page, posts) => {
			pages.set(page, posts);
		},
		markFailed: async (failure) => {
			failures.set(failure.page, failure);
		},
		clearFailed: async (page) => {
			failures.delete(page);
		},
	};
	return { cache, pages, failures };
}

describe("calendar-month date validation", () => {
	test("default range is valid and ends today in Asia/Shanghai", () => {
		const range = defaultDateRange(new Date("2026-03-31T08:00:00Z"));
		expect(range).toEqual({ startDate: "2026-03-01", endDate: "2026-03-31" });
		expect(() =>
			validateDateRange(range.startDate, range.endDate),
		).not.toThrow();
	});

	test("accepts full, cross-month, cross-year, February and leap-year ranges", () => {
		for (const [start, end] of [
			["2023-05-01", "2023-05-31"],
			["2023-05-15", "2023-06-14"],
			["2023-12-15", "2024-01-14"],
			["2023-02-01", "2023-02-28"],
			["2024-02-01", "2024-02-29"],
			["2024-06-10", "2024-06-10"],
		] as const) {
			expect(() => validateDateRange(start, end)).not.toThrow();
		}
	});

	test("clamps month-end and rejects invalid or overlong ranges", () => {
		expect(maxEndDateForStart("2023-01-31")).toBe("2023-02-27");
		expect(maxEndDateForStart("2024-01-31")).toBe("2024-02-28");
		expect(() => validateDateRange("2023-05-01", "2023-06-15")).toThrow(
			"最多一个自然月",
		);
		expect(() => validateDateRange("2023-02-29", "2023-03-01")).toThrow(
			"日期不存在",
		);
		expect(() => validateDateRange("2023-05-02", "2023-05-01")).toThrow(
			"不能早于",
		);
	});
});

describe("exponential seek and tolerant binary boundaries", () => {
	test("page 1 is newer than page 2 using full-page min/max bounds", () => {
		const page1 = pageTimeBounds(1, [postForPage(1), postForPage(2, "p1-old")]);
		const page2 = pageTimeBounds(2, [postForPage(3), postForPage(4)]);
		expect(page1?.minTime).toBeGreaterThan(page2?.maxTime ?? 0);
	});

	test("exponential probes bracket the start date without sequential history scan", async () => {
		const calls: number[] = [];
		const located = await locatePages(
			async (page) => {
				calls.push(page);
				return page > 700 ? [] : [postForPage(page)];
			},
			postForPage(520).createTime * 1_000,
			postForPage(500).createTime * 1_000 + 1,
			undefined,
			1_024,
		);
		expect([1, 2, 4, 8, 16, 32, 64, 128, 256, 512]).toEqual(
			expect.arrayContaining(
				calls.filter((page) => (page & (page - 1)) === 0 && page <= 512),
			),
		);
		expect(located.fromPage).toBeLessThanOrEqual(500);
		expect(located.toPage).toBeGreaterThanOrEqual(520);
		expect(calls.length).toBeLessThan(80);
	});

	test("a target spanning exponential regions gets two correct binary boundaries", async () => {
		const located = await locatePages(
			async (page) => (page > 900 ? [] : [postForPage(page)]),
			postForPage(520).createTime * 1_000,
			postForPage(250).createTime * 1_000 + 1,
			undefined,
			1_024,
		);
		expect(located.fromPage).toBeLessThanOrEqual(250);
		expect(located.toPage).toBeGreaterThanOrEqual(520);
		expect(located.unresolved).toBe(false);
	});

	test("mixed adjacent-month records are filtered immediately by milliseconds", () => {
		const { startMs, endExclusiveMs } = validateDateRange(
			"2023-05-01",
			"2023-05-31",
		);
		const posts = [
			postForPage(1, "april", {
				createTime: Date.parse("2023-04-30T23:59:59+08:00") / 1_000,
			}),
			postForPage(1, "may", {
				createTime: Date.parse("2023-05-15T12:00:00+08:00") / 1_000,
			}),
			postForPage(1, "june", {
				createTime: Date.parse("2023-06-01T00:00:00+08:00") / 1_000,
			}),
		];
		expect(
			filterDate(posts, startMs, endExclusiveMs).map((post) => post.cid),
		).toEqual(["cid-may"]);
	});

	test("page 319 permanent HTTP 500 probes 318/320 and never loops", async () => {
		const attempts = new Map<number, number>();
		const fetchPage = (page: number) =>
			withExponentialRetry(
				async () => {
					attempts.set(page, (attempts.get(page) ?? 0) + 1);
					if (page === 319) {
						throw new PageRequestError("HTTP 500", {
							retryable: true,
							status: 500,
						});
					}
					return page > 450 ? [] : [postForPage(page)];
				},
				{ maxAttempts: 3, sleep: async () => {}, jitterRatio: 0 },
			);
		const located = await locatePages(
			fetchPage,
			postForPage(322).createTime * 1_000,
			postForPage(319).createTime * 1_000 + 1,
			undefined,
			512,
		);
		expect(attempts.get(319)).toBe(3);
		expect(located.failedPages).toContain(319);
		expect(located.boundaryUncertain).toBe(true);
		expect(located.toPage).toBeGreaterThanOrEqual(320);
	});

	test("continuous failed pages make the boundary uncertain", async () => {
		const located = await locatePages(
			async (page) => {
				if (page >= 316 && page <= 321) throw new Error(`failed-${page}`);
				return page > 450 ? [] : [postForPage(page)];
			},
			postForPage(325).createTime * 1_000,
			postForPage(315).createTime * 1_000 + 1,
			undefined,
			512,
		);
		expect(located.boundaryUncertain).toBe(true);
		expect(located.failedPages.length).toBeGreaterThan(0);
	});

	test("ordering inversion, unexpected empty page and page cap exit safely", async () => {
		const inverted = await locatePages(
			async (page) => {
				if (page === 2) {
					return [
						postForPage(1, "future", {
							createTime: NEWEST_SECONDS + DAY_SECONDS,
						}),
					];
				}
				return page > 8 ? [] : [postForPage(page)];
			},
			postForPage(6).createTime * 1_000,
			postForPage(2).createTime * 1_000 + 1,
			undefined,
			16,
		);
		expect(inverted.boundaryUncertain).toBe(true);
		expect(inverted.notes.some((note) => note.includes("逆序"))).toBe(true);

		const emptyGap = await locatePages(
			async (page) => (page === 4 ? [] : [postForPage(page)]),
			postForPage(10).createTime * 1_000,
			postForPage(2).createTime * 1_000 + 1,
			undefined,
			16,
		);
		expect(emptyGap.boundaryUncertain).toBe(true);

		const capped = await locatePages(
			async (page) => [postForPage(page)],
			postForPage(100).createTime * 1_000,
			postForPage(90).createTime * 1_000,
			undefined,
			16,
		);
		expect(capped.unresolved).toBe(true);
	});
});

describe("retry and cancellation", () => {
	test("429 honors Retry-After and 500/timeout use finite exponential backoff", async () => {
		const delays: number[] = [];
		let attempts = 0;
		await expect(
			withExponentialRetry(
				async () => {
					attempts++;
					throw new PageRequestError(attempts === 1 ? "429" : "timeout", {
						retryable: true,
						status: attempts === 1 ? 429 : 500,
						retryAfterMs: attempts === 1 ? 350 : undefined,
					});
				},
				{
					maxAttempts: 4,
					baseDelayMs: 100,
					jitterRatio: 0,
					sleep: async (delay) => void delays.push(delay),
				},
			),
		).rejects.toThrow("timeout");
		expect(attempts).toBe(4);
		expect(delays).toEqual([350, 200, 400]);
	});

	test("AbortSignal interrupts backoff promptly", async () => {
		const controller = new AbortController();
		const pending = withExponentialRetry(
			async () => {
				throw new PageRequestError("500", { retryable: true, status: 500 });
			},
			{ signal: controller.signal, baseDelayMs: 10_000 },
		).catch((error: unknown) => error);
		controller.abort();
		expect(isAbortError(await pending)).toBe(true);
	});
});

describe("bounded workers and streaming pipeline", () => {
	test("shared scheduler enforces its global in-flight limit", async () => {
		const scheduler = new RequestScheduler({
			requestsPerSecond: 10_000,
			maxConcurrent: 3,
		});
		await Promise.all(
			Array.from({ length: 9 }, () =>
				scheduler.schedule(async () => {
					await abortableDelay(5);
				}),
			),
		);
		expect(scheduler.stats().peak).toBe(3);
		expect(scheduler.stats().started).toBe(9);
	});

	test("page workers honor configured concurrency and can exceed two", async () => {
		const store = memoryCache();
		let active = 0;
		let peak = 0;
		await collectPages({
			pages: [1, 2, 3, 4, 5, 6, 7, 8],
			concurrency: 6,
			cache: store.cache,
			fetchPage: async (page) => {
				active++;
				peak = Math.max(peak, active);
				await abortableDelay(5);
				active--;
				return [postForPage(page)];
			},
		});
		expect(peak).toBeGreaterThan(2);
		expect(peak).toBeLessThanOrEqual(6);
	});

	test("classification starts after the first page, before all pages finish", async () => {
		const events: string[] = [];
		const result = await runStreamingReplyPipeline({
			pages: [1, 2, 3],
			startMs: 0,
			endExclusiveMs: Number.MAX_SAFE_INTEGER,
			pageConcurrency: 3,
			classificationConcurrency: 2,
			loadPage: async (page) => {
				await abortableDelay(page === 1 ? 1 : 30);
				events.push(`page-${page}`);
				return { posts: [postForPage(page)], source: "network" };
			},
			classify: async (post) => {
				events.push(`classify-${post.cid}`);
				return "nested";
			},
		});
		expect(events.indexOf("classify-cid-1")).toBeLessThan(
			events.indexOf("page-2"),
		);
		expect(result.metrics.firstConfirmedAt).toBeDefined();
		expect(result.metrics.firstConfirmedAt ?? 0).toBeLessThanOrEqual(
			result.metrics.finishedAt,
		);
	});

	test("bounded queue applies producer backpressure", async () => {
		const queue = new AsyncBoundedQueue<number>(1);
		await queue.push(1);
		let secondFinished = false;
		const second = queue.push(2).then(() => {
			secondFinished = true;
		});
		await abortableDelay(2);
		expect(secondFinished).toBe(false);
		expect(await queue.shift()).toBe(1);
		await second;
		expect(await queue.shift()).toBe(2);
		queue.close();
	});

	test("failed pages do not stop successful pages and resume uses cache", async () => {
		const store = memoryCache({ 1: [postForPage(1)] });
		const first = await collectPages({
			pages: [1, 2, 3],
			concurrency: 3,
			cache: store.cache,
			fetchPage: async (page) => {
				if (page === 2) throw new Error("temporary");
				return [postForPage(page)];
			},
		});
		expect(first.cached).toEqual([1]);
		expect(first.succeeded).toEqual([3]);
		expect(first.failed.map((failure) => failure.page)).toEqual([2]);
		const calls: number[] = [];
		await collectPages({
			pages: [1, 2, 3],
			cache: store.cache,
			fetchPage: async (page) => {
				calls.push(page);
				return [postForPage(page)];
			},
		});
		expect(calls).toEqual([2]);
	});
});

describe("reply verification", () => {
	test("unknown classifications can be retried independently", async () => {
		const post = postForPage(1, "retry-unknown", { affiliated: false });
		const first = await runClassificationPool({
			posts: [post],
			classify: async () => {
				throw new Error("temporary first-floor failure");
			},
		});
		expect(first[0]?.kind).toBe("unknown");

		const retried = await runClassificationPool({
			posts: first.map((item) => item.post),
			classify: async () => "floor",
		});
		expect(retried[0]?.kind).toBe("floor");
	});

	test("concurrent records sharing threadId share one first-floor request", async () => {
		let loads = 0;
		const resolver = createFirstFloorResolver({
			getCached: async () => undefined,
			load: async () => {
				loads++;
				await abortableDelay(5);
				return "first";
			},
			persist: async () => {},
		});
		await Promise.all([resolver("same"), resolver("same"), resolver("same")]);
		expect(loads).toBe(1);
	});

	test("affiliated replies never request the first floor", async () => {
		let calls = 0;
		const classifier = createReplyClassifier(async () => {
			calls++;
			return "first";
		});
		expect(await classifier(postForPage(1))).toBe("nested");
		expect(calls).toBe(0);
	});

	test("deduplicates replies and excludes verified thread starters", async () => {
		const duplicate = postForPage(1, "duplicate");
		const thread = postForPage(1, "thread", {
			affiliated: false,
			cid: "first",
			threadId: "same-thread",
		});
		const reply = postForPage(1, "reply", {
			affiliated: false,
			threadId: "same-thread",
		});
		const classifier = createReplyClassifier(async () => "first");
		const result = await runStreamingReplyPipeline({
			pages: [1],
			startMs: 0,
			endExclusiveMs: Number.MAX_SAFE_INTEGER,
			loadPage: async () => ({
				posts: [duplicate, { ...duplicate }, thread, reply],
				source: "network",
			}),
			classify: classifier,
		});
		expect(result.progress.candidates).toBe(3);
		expect(
			result.classified.filter((item) => item.kind === "thread"),
		).toHaveLength(1);
		expect(
			result.classified.filter((item) => item.kind === "floor"),
		).toHaveLength(1);
		expect(result.progress.confirmed).toBe(2);
	});
});

describe("persistence safety and completion", () => {
	test("migrates v2 tasks without trusting stale page mapping", () => {
		const query = {
			method: "uid" as const,
			id: "1185672699",
			startDate: "2023-05-01",
			endDate: "2023-05-31",
		};
		const migrated = migrateHistoricalTask(
			{
				version: 2,
				query,
				phase: "complete",
				fromPage: 10,
				toPage: 20,
				checkedPages: [10, 11],
				failedPages: {},
				updatedAt: 123,
			},
			query,
			456,
		);
		expect(migrated?.version).toBe(3);
		expect(migrated?.requiresRelocation).toBe(true);
		expect(migrated?.boundary).toBeUndefined();
		expect(migrated?.pageStates["10"]?.status).toBe("cached");
	});

	test("page fingerprint detects dynamic page-number drift", () => {
		const original = [postForPage(1, "a"), postForPage(1, "b")];
		const fingerprint = pageFingerprint(original);
		expect(pageMappingDrifted(fingerprint, [...original])).toBe(false);
		expect(
			pageMappingDrifted(fingerprint, [postForPage(1, "new"), ...original]),
		).toBe(true);
	});

	test("only every completeness condition produces COMPLETE", () => {
		const complete = {
			boundaryUncertain: false,
			orderingVerified: true,
			pendingPages: 0,
			failedPages: 0,
			pendingClassifications: 0,
			unknownClassifications: 0,
		};
		expect(completionStatus(complete)).toBe("COMPLETE");
		for (const key of Object.keys(complete) as Array<keyof typeof complete>) {
			const changed = { ...complete };
			if (typeof changed[key] === "boolean") {
				(changed[key] as boolean) = key !== "orderingVerified";
			} else {
				(changed[key] as number) = 1;
			}
			expect(completionStatus(changed)).toBe("PARTIAL");
		}
	});

	test("uniquePosts remains stable across overlapping cached pages", () => {
		const same = postForPage(10, "same");
		expect(
			uniquePosts([same, { ...same }, postForPage(11, "unique")]),
		).toHaveLength(2);
	});
});
