/**
 * Resilient, single-page retrieval primitives for historical user replies.
 * Date input is interpreted in Asia/Shanghai (UTC+08), Tieba's date context.
 */
export interface DateReplyPost {
	forumId: number;
	forumName: string;
	title: string;
	threadId: string;
	postId: string;
	cid: string;
	createTime: number;
	affiliated: boolean;
	content: string;
	replyTo?: string;
}

export interface PageBounds {
	min: number;
	max: number;
}

export interface FailedPage {
	page: number;
	attempts: number;
	message: string;
	updatedAt: number;
}

export interface LocatedPageRange {
	fromPage: number;
	toPage: number;
	probeCount: number;
	failedPages: number[];
	unresolved: boolean;
	notes: string[];
}

export interface RetryOptions {
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	signal?: AbortSignal;
	shouldRetry?: (error: unknown) => boolean;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface PageCache {
	get(page: number): Promise<DateReplyPost[] | undefined>;
	put(page: number, posts: DateReplyPost[]): Promise<void>;
	markFailed(failure: FailedPage): Promise<void>;
	clearFailed(page: number): Promise<void>;
}

export interface CollectPagesOptions {
	pages: number[];
	fetchPage: (page: number, signal?: AbortSignal) => Promise<DateReplyPost[]>;
	cache: PageCache;
	concurrency?: number;
	signal?: AbortSignal;
	onProgress?: (completed: number, total: number, page: number) => void;
}

export interface CollectPagesResult {
	succeeded: number[];
	failed: FailedPage[];
	cached: number[];
}

export class PageRequestError extends Error {
	readonly retryable: boolean;
	readonly status?: number;

	constructor(
		message: string,
		options: { retryable: boolean; status?: number },
	) {
		super(message);
		this.name = "PageRequestError";
		this.retryable = options.retryable;
		this.status = options.status;
	}
}

export function abortError(): DOMException {
	return new DOMException("任务已暂停", "AbortError");
}

export function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

export async function abortableDelay(
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) throw abortError();
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(abortError());
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function withExponentialRetry<T>(
	operation: (attempt: number) => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const {
		maxAttempts = 4,
		baseDelayMs = 500,
		maxDelayMs = 4_000,
		signal,
		shouldRetry = (error) =>
			error instanceof PageRequestError && error.retryable,
		sleep = abortableDelay,
	} = options;
	if (maxAttempts < 1) throw new Error("maxAttempts 必须大于 0");

	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (signal?.aborted) throw abortError();
		try {
			return await operation(attempt);
		} catch (error) {
			if (isAbortError(error) || signal?.aborted) throw abortError();
			lastError = error;
			if (attempt === maxAttempts || !shouldRetry(error)) throw error;
			const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
			await sleep(delay, signal);
		}
	}
	throw lastError;
}

export function chinaDateBounds(
	start: string,
	end: string,
): { startMs: number; endExclusiveMs: number } {
	const valid = /^\d{4}-\d{2}-\d{2}$/;
	if (!valid.test(start) || !valid.test(end)) {
		throw new Error("日期格式必须是 YYYY-MM-DD");
	}
	const startMs = Date.parse(`${start}T00:00:00+08:00`);
	const endMs = Date.parse(`${end}T00:00:00+08:00`);
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || start > end) {
		throw new Error("日期范围不正确");
	}
	const validate = (date: string, ms: number) => {
		const [year, month, day] = date.split("-").map(Number);
		const shifted = new Date(ms + 8 * 3_600_000);
		return (
			shifted.getUTCFullYear() === year &&
			shifted.getUTCMonth() + 1 === month &&
			shifted.getUTCDate() === day
		);
	};
	if (!validate(start, startMs) || !validate(end, endMs)) {
		throw new Error("日期不存在");
	}
	return { startMs, endExclusiveMs: endMs + 86_400_000 };
}

function formatChinaDate(date: Date): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const value = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? "";
	return `${value("year")}-${value("month")}-${value("day")}`;
}

export function defaultDateRange(now = new Date()): {
	startDate: string;
	endDate: string;
} {
	const endDate = formatChinaDate(now);
	const [year, month, day] = endDate.split("-").map(Number);
	const targetMonth = month === 1 ? 12 : month - 1;
	const targetYear = month === 1 ? year - 1 : year;
	const daysInTargetMonth = new Date(
		Date.UTC(targetYear, targetMonth, 0),
	).getUTCDate();
	const clampedDay = Math.min(day, daysInTargetMonth);
	const startDate = `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
	return { startDate, endDate };
}

export function bounds(posts: DateReplyPost[]): PageBounds | null {
	const times = posts
		.map((post) => post.createTime)
		.filter((time) => Number.isFinite(time) && time > 0);
	if (times.length === 0) return null;
	return { min: Math.min(...times) * 1_000, max: Math.max(...times) * 1_000 };
}

export function filterDate(
	posts: DateReplyPost[],
	startMs: number,
	endExclusiveMs: number,
): DateReplyPost[] {
	return posts.filter(
		(post) =>
			post.createTime * 1_000 >= startMs &&
			post.createTime * 1_000 < endExclusiveMs,
	);
}

export function uniquePosts(posts: DateReplyPost[]): DateReplyPost[] {
	const seen = new Set<string>();
	return posts
		.filter((post) => {
			const key = `${post.threadId}/${post.postId}/${post.cid}/${post.createTime}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((left, right) => right.createTime - left.createTime);
}

export function replyKind(
	post: DateReplyPost,
	firstFloorId: string | null,
): "floor" | "nested" | "thread" | "unknown" {
	if (post.affiliated) return "nested";
	if (!firstFloorId || !post.cid || String(post.cid) === "0") return "unknown";
	if (String(post.cid) === String(firstFloorId)) return "thread";
	return "floor";
}

/**
 * Locates the date interval with exponential page jumps and tolerant binary search.
 * A failed request is never treated as an empty page. The locator probes adjacent
 * pages and records inaccessible pages so the collector can retry them later.
 */
export async function locatePages(
	fetchPage: (page: number) => Promise<DateReplyPost[]>,
	startMs: number,
	endExclusiveMs: number,
	notify?: (message: string) => void,
	maxPage = 16_384,
): Promise<LocatedPageRange> {
	type Probe = PageBounds | null | "failed";
	const looked = new Map<number, Probe>();
	const failed = new Set<number>();
	let probes = 0;

	const test = async (page: number): Promise<Probe> => {
		const previous = looked.get(page);
		if (previous !== undefined) return previous;
		notify?.(`定位历史页码：探测第 ${page} 页`);
		try {
			const posts = await fetchPage(page);
			const pageBounds = bounds(posts);
			if (posts.length > 0 && !pageBounds) {
				throw new Error(`第 ${page} 页缺少有效发言时间`);
			}
			looked.set(page, pageBounds);
			return pageBounds;
		} catch (error) {
			if (isAbortError(error)) throw error;
			failed.add(page);
			looked.set(page, "failed");
			notify?.(`第 ${page} 页暂不可访问，正在探测相邻页`);
			return "failed";
		} finally {
			probes++;
		}
	};

	const accessibleNear = async (
		target: number,
		minimum: number,
		maximum: number,
	): Promise<{ page: number; value: PageBounds | null } | null> => {
		const maxRadius = Math.max(target - minimum, maximum - target);
		for (let radius = 0; radius <= maxRadius; radius++) {
			const candidates =
				radius === 0 ? [target] : [target - radius, target + radius];
			for (const page of candidates) {
				if (page < minimum || page > maximum) continue;
				const value = await test(page);
				if (value !== "failed") return { page, value };
			}
		}
		return null;
	};

	const first = await accessibleNear(1, 1, Math.min(maxPage, 16));
	if (!first) {
		return {
			fromPage: 1,
			toPage: 0,
			probeCount: probes,
			failedPages: [...failed].sort((a, b) => a - b),
			unresolved: true,
			notes: ["首页及相邻页均不可访问，无法安全定位日期范围"],
		};
	}
	if (first.value === null) {
		return {
			fromPage: 1,
			toPage: 0,
			probeCount: probes,
			failedPages: [...failed].sort((a, b) => a - b),
			unresolved: false,
			notes: ["可访问的最新页面没有返回记录"],
		};
	}
	if (first.value.max < startMs) {
		return {
			fromPage: 1,
			toPage: 0,
			probeCount: probes,
			failedPages: [...failed].sort((a, b) => a - b),
			unresolved: false,
			notes: ["目前的最新记录已早于所选起始日期"],
		};
	}

	let lastAccessiblePage = first.page;
	let high = Math.max(2, first.page * 2);
	let expansionUnresolved = false;
	while (high <= maxPage) {
		const nearby = await accessibleNear(
			high,
			lastAccessiblePage + 1,
			Math.min(maxPage, high + Math.max(8, Math.floor(high / 8))),
		);
		if (!nearby) {
			expansionUnresolved = true;
			break;
		}
		lastAccessiblePage = nearby.page;
		if (nearby.value === null || nearby.value.max < startMs) {
			high = nearby.page;
			break;
		}
		if (nearby.page >= maxPage) {
			high = maxPage;
			break;
		}
		high = Math.min(maxPage, Math.max(high * 2, nearby.page + 1));
	}
	if (expansionUnresolved) {
		return {
			fromPage: 1,
			toPage: 0,
			probeCount: probes,
			failedPages: [...failed].sort((a, b) => a - b),
			unresolved: true,
			notes: ["连续多页不可访问，无法安全确定日期页码边界"],
		};
	}
	if (lastAccessiblePage >= maxPage) {
		const last = looked.get(lastAccessiblePage);
		if (last !== null && last !== "failed" && last && last.max >= startMs) {
			throw new Error(
				`已探测到 ${maxPage} 页仍未找到目标起始日期；停止以避免过量请求`,
			);
		}
	}

	const findFirst = async (
		predicate: (value: PageBounds | null) => boolean,
	): Promise<number> => {
		let low = 1;
		let upper = high;
		while (low < upper) {
			const previousLow = low;
			const previousUpper = upper;
			const middle = Math.floor((low + upper) / 2);
			const nearby = await accessibleNear(middle, low, upper);
			if (!nearby) return low;
			if (predicate(nearby.value)) upper = nearby.page;
			else low = nearby.page + 1;
			// The only unresolved candidate can be a failed page next to an
			// accessible boundary. Keep that page in the range instead of looping.
			if (low === previousLow && upper === previousUpper) return low;
		}
		return low;
	};

	const lower = await findFirst(
		(value) => value === null || value.min < endExclusiveMs,
	);
	const upperExclusive = await findFirst(
		(value) => value === null || value.max < startMs,
	);
	if (lower >= upperExclusive) {
		return {
			fromPage: lower,
			toPage: lower - 1,
			probeCount: probes,
			failedPages: [...failed].sort((a, b) => a - b),
			unresolved: false,
			notes: ["所选日期范围没有可返回的公开发言"],
		};
	}

	const fromPage = Math.max(1, lower - 2);
	const accessibleHigh = looked.get(high);
	const lastPage = accessibleHigh === null ? high - 1 : high;
	const toPage = Math.min(lastPage, upperExclusive + 1);
	return {
		fromPage,
		toPage: Math.max(fromPage - 1, toPage),
		probeCount: probes,
		failedPages: [...failed]
			.filter((page) => page >= fromPage && page <= toPage)
			.sort((a, b) => a - b),
		unresolved: false,
		notes: [
			"日期边界前后各扩展最多 2 页，并以精确时间戳筛选",
			"失败页仅记录为缺失，不会被当成历史末尾",
		],
	};
}

export async function collectPages({
	pages,
	fetchPage,
	cache,
	concurrency = 2,
	signal,
	onProgress,
}: CollectPagesOptions): Promise<CollectPagesResult> {
	const uniquePages = [...new Set(pages)].filter((page) => page > 0);
	const result: CollectPagesResult = { succeeded: [], failed: [], cached: [] };
	let cursor = 0;
	let completed = 0;

	const worker = async () => {
		while (true) {
			if (signal?.aborted) throw abortError();
			const index = cursor++;
			if (index >= uniquePages.length) return;
			const page = uniquePages[index];
			try {
				const cached = await cache.get(page);
				if (cached !== undefined) {
					result.cached.push(page);
					await cache.clearFailed(page);
				} else {
					const posts = await fetchPage(page, signal);
					await cache.put(page, posts);
					await cache.clearFailed(page);
					result.succeeded.push(page);
				}
			} catch (error) {
				if (isAbortError(error) || signal?.aborted) throw abortError();
				const failure: FailedPage = {
					page,
					attempts: 1,
					message: error instanceof Error ? error.message : String(error),
					updatedAt: Date.now(),
				};
				await cache.markFailed(failure);
				result.failed.push(failure);
			} finally {
				completed++;
				onProgress?.(completed, uniquePages.length, page);
			}
		}
	};

	const workerCount = Math.max(1, Math.min(2, concurrency, uniquePages.length));
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	result.succeeded.sort((a, b) => a - b);
	result.cached.sort((a, b) => a - b);
	result.failed.sort((a, b) => a.page - b.page);
	return result;
}
