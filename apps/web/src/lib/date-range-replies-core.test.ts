import { describe, expect, test } from "bun:test";
import {
	collectPages,
	type DateReplyPost,
	defaultDateRange,
	type FailedPage,
	locatePages,
	type PageCache,
	PageRequestError,
	uniquePosts,
	withExponentialRetry,
} from "./date-range-replies-core.ts";

const DAY_SECONDS = 86_400;
const NEWEST_SECONDS = Date.parse("2025-12-31T12:00:00+08:00") / 1_000;

function postForPage(page: number, id = String(page)): DateReplyPost {
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

describe("resilient historical reply collection", () => {
	test("default range ends today and starts one calendar month earlier", () => {
		expect(defaultDateRange(new Date("2026-03-31T08:00:00Z"))).toEqual({
			startDate: "2026-02-28",
			endDate: "2026-03-31",
		});
	});

	test("page 319 can keep returning HTTP 500 while adjacent pages succeed", async () => {
		const attempts = new Map<number, number>();
		const request = async (page: number) => {
			attempts.set(page, (attempts.get(page) ?? 0) + 1);
			if (page === 319) {
				throw new PageRequestError("HTTP 500: /user/posts?page=319", {
					retryable: true,
					status: 500,
				});
			}
			return page > 400 ? [] : [postForPage(page)];
		};
		const fetchPage = (page: number) =>
			withExponentialRetry(() => request(page), {
				maxAttempts: 3,
				baseDelayMs: 1,
				sleep: async () => {},
			});
		// Make page 319 the exact binary-search boundary so the locator must
		// distinguish its HTTP 500 from an empty end-of-history page.
		const endExclusiveMs = postForPage(319).createTime * 1_000 + 1;
		const startMs = postForPage(322).createTime * 1_000;

		const located = await locatePages(
			fetchPage,
			startMs,
			endExclusiveMs,
			undefined,
			512,
		);

		expect(attempts.get(319)).toBe(3);
		expect(located.failedPages).toContain(319);
		expect(located.fromPage).toBeLessThanOrEqual(318);
		expect(located.toPage).toBeGreaterThanOrEqual(320);
	});

	test("continuous failed pages are recorded and do not stop other pages", async () => {
		const store = memoryCache();
		const result = await collectPages({
			pages: [317, 318, 319, 320, 321],
			concurrency: 2,
			cache: store.cache,
			fetchPage: async (page) => {
				if (page >= 318 && page <= 320) throw new Error(`failed-${page}`);
				return [postForPage(page)];
			},
		});

		expect(result.succeeded).toEqual([317, 321]);
		expect(result.failed.map((failure) => failure.page)).toEqual([
			318, 319, 320,
		]);
		expect(store.pages.has(321)).toBe(true);
	});

	test("an unlocatable range is partial rather than an empty completion", async () => {
		const located = await locatePages(
			async (page) => {
				throw new Error(`failed-${page}`);
			},
			postForPage(10).createTime * 1_000,
			postForPage(5).createTime * 1_000,
			undefined,
			64,
		);

		expect(located.unresolved).toBe(true);
		expect(located.failedPages).toHaveLength(16);
		expect(located.notes[0]).toContain("无法安全定位");
	});

	test("a requested range newer than available history returns an empty range", async () => {
		const latest = postForPage(1).createTime * 1_000;
		const located = await locatePages(
			async (page) => [postForPage(page)],
			latest + DAY_SECONDS * 1_000,
			latest + DAY_SECONDS * 2_000,
			undefined,
			512,
		);

		expect(located.toPage).toBeLessThan(located.fromPage);
		expect(located.notes[0]).toContain("早于");
	});

	test("resume reuses successful pages and only requests missing pages", async () => {
		const store = memoryCache({ 1: [postForPage(1)] });
		const firstCalls: number[] = [];
		await collectPages({
			pages: [1, 2, 3],
			concurrency: 1,
			cache: store.cache,
			fetchPage: async (page) => {
				firstCalls.push(page);
				if (page === 2) throw new Error("temporary failure");
				return [postForPage(page)];
			},
		});
		expect(firstCalls).toEqual([2, 3]);
		expect(store.failures.has(2)).toBe(true);

		const resumeCalls: number[] = [];
		const resumed = await collectPages({
			pages: [1, 2, 3],
			concurrency: 1,
			cache: store.cache,
			fetchPage: async (page) => {
				resumeCalls.push(page);
				return [postForPage(page)];
			},
		});

		expect(resumeCalls).toEqual([2]);
		expect(resumed.cached).toEqual([1, 3]);
		expect(store.failures.size).toBe(0);
	});

	test("duplicate records from overlapping pages are removed", () => {
		const duplicate = postForPage(10, "same");
		const unique = postForPage(11, "unique");
		const result = uniquePosts([duplicate, unique, { ...duplicate }]);

		expect(result).toHaveLength(2);
		expect(result.map((post) => post.cid).sort()).toEqual([
			"cid-same",
			"cid-unique",
		]);
	});

	test("retry uses finite exponential backoff", async () => {
		const delays: number[] = [];
		let attempts = 0;
		await expect(
			withExponentialRetry(
				async () => {
					attempts++;
					throw new PageRequestError("HTTP 429", {
						retryable: true,
						status: 429,
					});
				},
				{
					maxAttempts: 4,
					baseDelayMs: 100,
					sleep: async (ms) => {
						delays.push(ms);
					},
				},
			),
		).rejects.toThrow("HTTP 429");
		expect(attempts).toBe(4);
		expect(delays).toEqual([100, 200, 400]);
	});
});
