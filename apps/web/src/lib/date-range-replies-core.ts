/** Pure, testable primitives for resilient date-targeted user reply crawling. */

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

export interface PageTimeBounds {
	page: number;
	minTime: number;
	maxTime: number;
}

export type PageProbeStatus = "success" | "empty" | "failed";

export interface PageProbe {
	page: number;
	status: PageProbeStatus;
	bounds?: PageTimeBounds;
	message?: string;
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
	emptyPages: number[];
	locatedPages: number[];
	boundaryUncertain: boolean;
	orderingVerified: boolean;
	unresolved: boolean;
	probes: PageProbe[];
	notes: string[];
}

export interface RetryOptions {
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	jitterRatio?: number;
	random?: () => number;
	signal?: AbortSignal;
	shouldRetry?: (error: unknown) => boolean;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
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

export type ReplyKind = "floor" | "nested" | "thread" | "unknown";

export interface ClassifiedReply {
	post: DateReplyPost;
	kind: ReplyKind;
	error?: string;
}

export interface PipelineProgress {
	targetPages: number;
	pagesSettled: number;
	pagesSucceeded: number;
	pagesFailed: number;
	cacheHits: number;
	candidates: number;
	classified: number;
	confirmed: number;
	unknown: number;
}

export interface PipelineMetrics {
	startedAt: number;
	finishedAt: number;
	firstCandidateAt?: number;
	firstConfirmedAt?: number;
	pageRequests: number;
	cacheHits: number;
	peakPageConcurrency: number;
	peakClassificationConcurrency: number;
	locationRequests?: number;
	classificationRequests?: number;
	totalHttpAttempts?: number;
	networkFailures?: number;
}

export interface PipelinePage {
	posts: DateReplyPost[];
	source: "network" | "cache" | "located";
}

export interface StreamingPipelineOptions {
	pages: number[];
	startMs: number;
	endExclusiveMs: number;
	loadPage: (page: number, signal?: AbortSignal) => Promise<PipelinePage>;
	classify: (post: DateReplyPost, signal?: AbortSignal) => Promise<ReplyKind>;
	pageConcurrency?: number;
	classificationConcurrency?: number;
	queueCapacity?: number;
	signal?: AbortSignal;
	onPage?: (
		page: number,
		status: "success" | "failed",
		detail: PipelinePage | FailedPage,
	) => Promise<void> | void;
	onCandidates?: (posts: DateReplyPost[], page: number) => Promise<void> | void;
	onClassified?: (result: ClassifiedReply) => Promise<void> | void;
	onProgress?: (progress: PipelineProgress) => void;
}

export interface StreamingPipelineResult {
	classified: ClassifiedReply[];
	failedPages: FailedPage[];
	progress: PipelineProgress;
	metrics: PipelineMetrics;
}

export interface CompletionInput {
	boundaryUncertain: boolean;
	orderingVerified: boolean;
	pendingPages: number;
	failedPages: number;
	pendingClassifications: number;
	unknownClassifications: number;
}

export type HistoricalTaskPhase =
	| "LOCATING"
	| "FETCHING"
	| "VERIFYING"
	| "PAUSED"
	| "PARTIAL"
	| "COMPLETE"
	| "ERROR";

export interface HistoricalTaskQuery {
	method: "id" | "uid" | "un";
	id: string;
	startDate: string;
	endDate: string;
}

export interface HistoricalPageState {
	status: "located" | "cached" | "success" | "failed";
	updatedAt: number;
	message?: string;
}

export interface HistoricalTaskV3 {
	version: 3;
	query: HistoricalTaskQuery;
	createdAt: number;
	updatedAt: number;
	phase: HistoricalTaskPhase;
	snapshotId: string;
	anchor?: { page: number; fingerprint: string };
	boundary?: {
		fromPage: number;
		toPage: number;
		uncertain: boolean;
		orderingVerified: boolean;
		probeCount: number;
		notes: string[];
	};
	pageStates: Record<string, HistoricalPageState>;
	progress: PipelineProgress;
	metrics?: PipelineMetrics;
	requiresRelocation?: boolean;
}

export interface LegacyTaskV2 {
	version: 2;
	query: HistoricalTaskQuery;
	phase: string;
	fromPage?: number;
	toPage?: number;
	checkedPages?: number[];
	failedPages?: Record<string, FailedPage>;
	probeCount?: number;
	updatedAt?: number;
}

export class PageRequestError extends Error {
	readonly retryable: boolean;
	readonly status?: number;
	readonly retryAfterMs?: number;

	constructor(
		message: string,
		options: { retryable: boolean; status?: number; retryAfterMs?: number },
	) {
		super(message);
		this.name = "PageRequestError";
		this.retryable = options.retryable;
		this.status = options.status;
		this.retryAfterMs = options.retryAfterMs;
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
		const timer = setTimeout(
			() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			Math.max(0, ms),
		);
		function onAbort() {
			clearTimeout(timer);
			reject(abortError());
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function isRetryableStatus(status: number): boolean {
	return (
		status === 429 ||
		status === 500 ||
		status === 502 ||
		status === 503 ||
		status === 504
	);
}

export async function withExponentialRetry<T>(
	operation: (attempt: number) => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const {
		maxAttempts = 4,
		baseDelayMs = 500,
		maxDelayMs = 8_000,
		jitterRatio = 0.2,
		random = Math.random,
		signal,
		shouldRetry = (error) =>
			error instanceof PageRequestError && error.retryable,
		sleep = abortableDelay,
		onRetry,
	} = options;
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
		throw new Error("maxAttempts 必须是大于 0 的整数");
	}

	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (signal?.aborted) throw abortError();
		try {
			return await operation(attempt);
		} catch (error) {
			if (isAbortError(error) || signal?.aborted) throw abortError();
			lastError = error;
			if (attempt === maxAttempts || !shouldRetry(error)) throw error;
			const exponential = Math.min(
				maxDelayMs,
				baseDelayMs * 2 ** (attempt - 1),
			);
			const jitter = exponential * jitterRatio * (random() * 2 - 1);
			const retryAfter =
				error instanceof PageRequestError ? (error.retryAfterMs ?? 0) : 0;
			const delay = Math.max(retryAfter, Math.round(exponential + jitter));
			onRetry?.(error, attempt, delay);
			await sleep(delay, signal);
		}
	}
	throw lastError;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function parseChinaDate(date: string): {
	ms: number;
	year: number;
	month: number;
	day: number;
} {
	if (!DATE_PATTERN.test(date)) throw new Error("日期格式必须是 YYYY-MM-DD");
	const [year, month, day] = date.split("-").map(Number);
	const ms = Date.parse(`${date}T00:00:00+08:00`);
	const shifted = new Date(ms + 8 * 3_600_000);
	if (
		!Number.isFinite(ms) ||
		shifted.getUTCFullYear() !== year ||
		shifted.getUTCMonth() + 1 !== month ||
		shifted.getUTCDate() !== day
	) {
		throw new Error(`日期不存在：${date}`);
	}
	return { ms, year, month, day };
}

function formatCalendarDate(year: number, month: number, day: number): string {
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addCalendarMonthClamped(date: string): string {
	const { year, month, day } = parseChinaDate(date);
	const targetYear = month === 12 ? year + 1 : year;
	const targetMonth = month === 12 ? 1 : month + 1;
	const days = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
	return formatCalendarDate(targetYear, targetMonth, Math.min(day, days));
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

export function maxEndDateForStart(startDate: string): string {
	const exclusiveLimit = parseChinaDate(addCalendarMonthClamped(startDate)).ms;
	const date = new Date(exclusiveLimit - DAY_MS + 8 * 3_600_000);
	return formatCalendarDate(
		date.getUTCFullYear(),
		date.getUTCMonth() + 1,
		date.getUTCDate(),
	);
}

export function validateDateRange(
	startDate: string,
	endDate: string,
): { startMs: number; endExclusiveMs: number; maxEndDate: string } {
	const start = parseChinaDate(startDate);
	const end = parseChinaDate(endDate);
	if (end.ms < start.ms) throw new Error("结束日期不能早于开始日期");
	const maxEndDate = maxEndDateForStart(startDate);
	if (endDate > maxEndDate) {
		throw new Error(
			`日期范围最多一个自然月；当前开始日期最晚可选 ${maxEndDate}`,
		);
	}
	return { startMs: start.ms, endExclusiveMs: end.ms + DAY_MS, maxEndDate };
}

/** Backward-compatible name used by the existing component. */
export function chinaDateBounds(
	startDate: string,
	endDate: string,
): { startMs: number; endExclusiveMs: number } {
	const { startMs, endExclusiveMs } = validateDateRange(startDate, endDate);
	return { startMs, endExclusiveMs };
}

export function defaultDateRange(now = new Date()): {
	startDate: string;
	endDate: string;
} {
	const endDate = formatChinaDate(now);
	const end = parseChinaDate(endDate);
	const previousMonthYear = end.month === 1 ? end.year - 1 : end.year;
	const previousMonth = end.month === 1 ? 12 : end.month - 1;
	const previousDays = new Date(
		Date.UTC(previousMonthYear, previousMonth, 0),
	).getUTCDate();
	const previousSameDay = formatCalendarDate(
		previousMonthYear,
		previousMonth,
		Math.min(end.day, previousDays),
	);
	const startMs = parseChinaDate(previousSameDay).ms + DAY_MS;
	const start = new Date(startMs + 8 * 3_600_000);
	return {
		startDate: formatCalendarDate(
			start.getUTCFullYear(),
			start.getUTCMonth() + 1,
			start.getUTCDate(),
		),
		endDate,
	};
}

export function pageTimeBounds(
	page: number,
	posts: DateReplyPost[],
): PageTimeBounds | null {
	const times = posts
		.map((post) => post.createTime * 1_000)
		.filter((time) => Number.isFinite(time) && time > 0);
	if (times.length === 0) return null;
	return { page, minTime: Math.min(...times), maxTime: Math.max(...times) };
}

export function bounds(
	posts: DateReplyPost[],
): { min: number; max: number } | null {
	const value = pageTimeBounds(0, posts);
	return value ? { min: value.minTime, max: value.maxTime } : null;
}

export function filterDate(
	posts: DateReplyPost[],
	startMs: number,
	endExclusiveMs: number,
): DateReplyPost[] {
	return posts.filter((post) => {
		const time = post.createTime * 1_000;
		return time >= startMs && time < endExclusiveMs;
	});
}

export function postIdentity(post: DateReplyPost): string {
	return `${post.threadId}/${post.postId}/${post.cid}/${post.createTime}`;
}

export function uniquePosts(posts: DateReplyPost[]): DateReplyPost[] {
	const seen = new Set<string>();
	return posts
		.filter((post) => {
			const key = postIdentity(post);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((left, right) => right.createTime - left.createTime);
}

export function replyKind(
	post: DateReplyPost,
	firstFloorId: string | null,
): ReplyKind {
	if (post.affiliated) return "nested";
	if (!firstFloorId || !post.cid || String(post.cid) === "0") return "unknown";
	if (String(post.cid) === String(firstFloorId)) return "thread";
	return "floor";
}

function sortedNumbers(values: Iterable<number>): number[] {
	return [...values].sort((left, right) => left - right);
}

/** Exponential seek followed by two tolerant, strictly converging binary searches. */
export async function locatePages(
	fetchPage: (page: number) => Promise<DateReplyPost[]>,
	startMs: number,
	endExclusiveMs: number,
	notify?: (message: string) => void,
	maxPage = 16_384,
): Promise<LocatedPageRange> {
	const probes = new Map<number, PageProbe>();
	const failed = new Set<number>();
	const empty = new Set<number>();
	const notes: string[] = [];
	let boundaryUncertain = false;
	let orderingVerified = false;
	let orderingAnomaly = false;

	const checkOrdering = () => {
		const successful = [...probes.values()]
			.filter((probe): probe is PageProbe & { bounds: PageTimeBounds } =>
				Boolean(probe.bounds),
			)
			.sort((left, right) => left.page - right.page);
		if (successful.length >= 2) orderingVerified = true;
		for (let index = 1; index < successful.length; index++) {
			const newer = successful[index - 1];
			const older = successful[index];
			if (newer.bounds.maxTime < older.bounds.minTime) {
				orderingAnomaly = true;
				boundaryUncertain = true;
				const message = `检测到页码时间逆序：第 ${newer.page} 页整体早于第 ${older.page} 页`;
				if (!notes.includes(message)) notes.push(message);
			}
		}
	};

	const probe = async (page: number): Promise<PageProbe> => {
		const existing = probes.get(page);
		if (existing) return existing;
		notify?.(`定位探测第 ${page} 页`);
		let value: PageProbe;
		try {
			const posts = await fetchPage(page);
			const timeBounds = pageTimeBounds(page, posts);
			if (posts.length > 0 && !timeBounds) {
				throw new Error(`第 ${page} 页没有有效时间戳`);
			}
			if (timeBounds) value = { page, status: "success", bounds: timeBounds };
			else {
				empty.add(page);
				value = { page, status: "empty" };
			}
		} catch (error) {
			if (isAbortError(error)) throw error;
			failed.add(page);
			boundaryUncertain = true;
			value = {
				page,
				status: "failed",
				message: error instanceof Error ? error.message : String(error),
			};
		}
		probes.set(page, value);
		checkOrdering();
		return value;
	};

	const usableNear = async (
		target: number,
		minimum: number,
		maximum: number,
	): Promise<PageProbe | null> => {
		if (minimum > maximum) return null;
		const maxRadius = Math.max(target - minimum, maximum - target);
		for (let radius = 0; radius <= maxRadius; radius++) {
			const candidates =
				radius === 0 ? [target] : [target - radius, target + radius];
			for (const page of candidates) {
				if (page < minimum || page > maximum) continue;
				const value = await probe(page);
				if (value.status !== "failed") return value;
			}
		}
		return null;
	};

	const finish = (
		fromPage: number,
		toPage: number,
		unresolved: boolean,
	): LocatedPageRange => {
		const relevantFailed = sortedNumbers(failed).filter(
			(page) =>
				unresolved || (page >= Math.max(1, fromPage - 1) && page <= toPage + 1),
		);
		if (relevantFailed.length > 0) boundaryUncertain = true;
		if (orderingAnomaly) boundaryUncertain = true;
		return {
			fromPage,
			toPage,
			probeCount: probes.size,
			failedPages: relevantFailed,
			emptyPages: sortedNumbers(empty),
			locatedPages: sortedNumbers(
				[...probes.values()]
					.filter((value) => value.status !== "failed")
					.map((value) => value.page),
			),
			boundaryUncertain,
			orderingVerified,
			unresolved,
			probes: [...probes.values()].sort(
				(left, right) => left.page - right.page,
			),
			notes,
		};
	};

	const first = await usableNear(1, 1, Math.min(maxPage, 8));
	if (!first) {
		notes.push("首页及相邻页均不可访问，无法安全定位");
		return finish(1, 0, true);
	}
	if (first.page !== 1) {
		boundaryUncertain = true;
		notes.push(`首页不可访问，使用第 ${first.page} 页继续定位`);
	}
	if (first.status === "empty") {
		const neighbor = first.page < maxPage ? await probe(first.page + 1) : first;
		if (neighbor.status === "success") {
			boundaryUncertain = true;
			notes.push("空页之后仍有记录，页序不稳定");
		} else {
			if (neighbor.status === "empty") orderingVerified = true;
			notes.push("最新可访问页为空");
			return finish(1, 0, neighbor.status === "failed");
		}
	}
	if (first.bounds && first.bounds.maxTime < startMs) {
		notes.push("最新记录已经早于查询范围");
		return finish(1, 0, false);
	}

	let previousPage = first.page;
	let high = Math.max(2, 2 ** Math.ceil(Math.log2(first.page + 1)));
	let bracketed = false;
	while (high <= maxPage) {
		const sample = await usableNear(
			high,
			previousPage + 1,
			Math.min(maxPage, high + 8),
		);
		if (!sample) {
			notes.push(`第 ${high} 页附近连续失败，无法建立可靠边界`);
			return finish(1, 0, true);
		}
		if (sample.page !== high) {
			boundaryUncertain = true;
			notes.push(`第 ${high} 页失败，使用相邻第 ${sample.page} 页定位`);
		}
		previousPage = sample.page;
		if (sample.status === "empty") {
			const next =
				sample.page < maxPage ? await probe(sample.page + 1) : sample;
			if (next.status === "success") {
				boundaryUncertain = true;
				notes.push(`第 ${sample.page} 页意外为空但后页有记录`);
			} else {
				if (next.status === "empty") orderingVerified = true;
				high = sample.page;
				bracketed = true;
				break;
			}
		}
		if (sample.bounds && sample.bounds.maxTime < startMs) {
			high = sample.page;
			bracketed = true;
			break;
		}
		if (sample.page >= maxPage) break;
		high = Math.min(maxPage, high * 2);
	}
	if (!bracketed) {
		notes.push(`到达页码上限 ${maxPage}，仍未可靠跨过开始日期`);
		return finish(1, 0, true);
	}

	const findFirst = async (
		predicate: (probe: PageProbe) => boolean,
	): Promise<number> => {
		let low = 1;
		let upper = high;
		while (low < upper) {
			const oldLow = low;
			const oldUpper = upper;
			const middle = Math.floor((low + upper) / 2);
			const sample = await usableNear(middle, low, upper);
			if (!sample) {
				boundaryUncertain = true;
				return low;
			}
			if (sample.page !== middle) boundaryUncertain = true;
			if (predicate(sample)) upper = sample.page;
			else low = sample.page + 1;
			if (low === oldLow && upper === oldUpper) {
				boundaryUncertain = true;
				return low;
			}
		}
		return low;
	};

	const isBeforeEnd = (value: PageProbe) =>
		value.status === "empty" ||
		Boolean(value.bounds && value.bounds.minTime < endExclusiveMs);
	const isBeforeStart = (value: PageProbe) =>
		value.status === "empty" ||
		Boolean(value.bounds && value.bounds.maxTime < startMs);
	const lower = await findFirst(isBeforeEnd);
	const upperExclusive = await findFirst(isBeforeStart);
	if (lower >= upperExclusive) {
		notes.push("查询范围没有可见记录");
		return finish(lower, lower - 1, false);
	}

	const fromPage = Math.max(1, lower - 1);
	const toPage = Math.min(high, upperExclusive);
	await probe(fromPage);
	await probe(toPage);
	if (fromPage > 1) await probe(fromPage - 1);
	if (toPage < maxPage) await probe(toPage + 1);
	notes.push("指数搜索仅建立边界，二分定位后只抓取目标页范围");
	return finish(fromPage, toPage, false);
}

function clampInteger(value: number, minimum: number, maximum: number): number {
	if (!Number.isFinite(value)) return minimum;
	return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

export async function collectPages({
	pages,
	fetchPage,
	cache,
	concurrency = 6,
	signal,
	onProgress,
}: CollectPagesOptions): Promise<CollectPagesResult> {
	const uniquePages = sortedNumbers(new Set(pages)).filter((page) => page > 0);
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
	const count = Math.min(uniquePages.length, clampInteger(concurrency, 1, 8));
	await Promise.all(Array.from({ length: count }, () => worker()));
	result.succeeded.sort((a, b) => a - b);
	result.cached.sort((a, b) => a - b);
	result.failed.sort((a, b) => a.page - b.page);
	return result;
}

class Semaphore {
	private available: number;
	private readonly waiters: Array<() => void> = [];

	constructor(size: number) {
		this.available = size;
	}

	async acquire(signal?: AbortSignal): Promise<() => void> {
		while (this.available === 0) {
			await waitForWake(this.waiters, signal);
		}
		this.available--;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.available++;
			this.waiters.shift()?.();
		};
	}
}

function waitForWake(
	waiters: Array<() => void>,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const wake = () => {
			cleanup();
			resolve();
		};
		const onAbort = () => {
			const index = waiters.indexOf(wake);
			if (index >= 0) waiters.splice(index, 1);
			cleanup();
			reject(abortError());
		};
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		waiters.push(wake);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export class RequestScheduler {
	readonly configuredRate: number;
	readonly maxConcurrent: number;
	private currentRate: number;
	private nextStartAt = 0;
	private penaltyUntil = 0;
	private startGate = Promise.resolve();
	private readonly semaphore: Semaphore;
	private active = 0;
	private peak = 0;
	private started = 0;

	constructor(
		options: { requestsPerSecond?: number; maxConcurrent?: number } = {},
	) {
		this.configuredRate = Math.max(0.5, options.requestsPerSecond ?? 5);
		this.currentRate = this.configuredRate;
		this.maxConcurrent = clampInteger(options.maxConcurrent ?? 5, 1, 12);
		this.semaphore = new Semaphore(this.maxConcurrent);
	}

	penalize(retryAfterMs = 0) {
		this.currentRate = Math.max(1, this.currentRate / 2);
		this.penaltyUntil = Math.max(this.penaltyUntil, Date.now() + retryAfterMs);
	}

	stats() {
		return {
			started: this.started,
			active: this.active,
			peak: this.peak,
			currentRate: this.currentRate,
		};
	}

	async schedule<T>(
		operation: () => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const release = await this.semaphore.acquire(signal);
		try {
			let unlock!: () => void;
			const previous = this.startGate;
			this.startGate = new Promise<void>((resolve) => {
				unlock = resolve;
			});
			await previous;
			try {
				const waitUntil = Math.max(this.nextStartAt, this.penaltyUntil);
				await abortableDelay(Math.max(0, waitUntil - Date.now()), signal);
				this.nextStartAt = Date.now() + 1_000 / this.currentRate;
			} finally {
				unlock();
			}
			if (signal?.aborted) throw abortError();
			this.active++;
			this.started++;
			this.peak = Math.max(this.peak, this.active);
			try {
				const value = await operation();
				this.currentRate = Math.min(
					this.configuredRate,
					this.currentRate + 0.25,
				);
				return value;
			} finally {
				this.active--;
			}
		} finally {
			release();
		}
	}
}

export class AsyncBoundedQueue<T> {
	private readonly items: T[] = [];
	private readonly readers: Array<() => void> = [];
	private readonly writers: Array<() => void> = [];
	private closed = false;

	constructor(readonly capacity: number) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new Error("队列容量必须是大于 0 的整数");
		}
	}

	async push(value: T, signal?: AbortSignal): Promise<void> {
		while (this.items.length >= this.capacity && !this.closed) {
			await waitForWake(this.writers, signal);
		}
		if (this.closed) throw new Error("队列已经关闭");
		this.items.push(value);
		this.readers.shift()?.();
	}

	async shift(signal?: AbortSignal): Promise<T | undefined> {
		while (this.items.length === 0 && !this.closed) {
			await waitForWake(this.readers, signal);
		}
		const value = this.items.shift();
		if (value !== undefined) this.writers.shift()?.();
		return value;
	}

	close() {
		this.closed = true;
		for (const wake of this.readers.splice(0)) wake();
		for (const wake of this.writers.splice(0)) wake();
	}
}

export function createFirstFloorResolver(options: {
	getCached: (threadId: string) => Promise<string | undefined>;
	load: (threadId: string, signal?: AbortSignal) => Promise<string | null>;
	persist: (threadId: string, firstFloorId: string) => Promise<void>;
}) {
	const memory = new Map<string, string>();
	const inFlight = new Map<string, Promise<string | null>>();
	return async (
		threadId: string,
		signal?: AbortSignal,
	): Promise<string | null> => {
		const remembered = memory.get(threadId);
		if (remembered !== undefined) return remembered;
		const existing = inFlight.get(threadId);
		if (existing) return existing;
		const request = (async () => {
			const cached = await options.getCached(threadId);
			if (cached !== undefined) {
				memory.set(threadId, cached);
				return cached;
			}
			const loaded = await options.load(threadId, signal);
			if (loaded) {
				memory.set(threadId, loaded);
				await options.persist(threadId, loaded);
			}
			return loaded;
		})().finally(() => inFlight.delete(threadId));
		inFlight.set(threadId, request);
		return request;
	};
}

export function createReplyClassifier(
	resolveFirstFloor: (
		threadId: string,
		signal?: AbortSignal,
	) => Promise<string | null>,
) {
	return async (
		post: DateReplyPost,
		signal?: AbortSignal,
	): Promise<ReplyKind> => {
		if (post.affiliated) return "nested";
		const firstFloorId = await resolveFirstFloor(post.threadId, signal);
		return replyKind(post, firstFloorId);
	};
}

export async function runClassificationPool(options: {
	posts: DateReplyPost[];
	classify: (post: DateReplyPost, signal?: AbortSignal) => Promise<ReplyKind>;
	concurrency?: number;
	signal?: AbortSignal;
	onClassified?: (result: ClassifiedReply) => Promise<void> | void;
}): Promise<ClassifiedReply[]> {
	const posts = uniquePosts(options.posts);
	const results: ClassifiedReply[] = [];
	let cursor = 0;
	const worker = async () => {
		while (true) {
			if (options.signal?.aborted) throw abortError();
			const index = cursor++;
			if (index >= posts.length) return;
			const post = posts[index];
			let result: ClassifiedReply;
			try {
				result = { post, kind: await options.classify(post, options.signal) };
			} catch (error) {
				if (isAbortError(error) || options.signal?.aborted) throw abortError();
				result = {
					post,
					kind: "unknown",
					error: error instanceof Error ? error.message : String(error),
				};
			}
			results.push(result);
			await options.onClassified?.(result);
		}
	};
	const count = Math.min(
		posts.length,
		clampInteger(options.concurrency ?? 3, 1, 4),
	);
	await Promise.all(Array.from({ length: count }, () => worker()));
	return results;
}

export async function runStreamingReplyPipeline({
	pages,
	startMs,
	endExclusiveMs,
	loadPage,
	classify,
	pageConcurrency = 6,
	classificationConcurrency = 3,
	queueCapacity = 120,
	signal,
	onPage,
	onCandidates,
	onClassified,
	onProgress,
}: StreamingPipelineOptions): Promise<StreamingPipelineResult> {
	const targetPages = sortedNumbers(new Set(pages)).filter((page) => page > 0);
	const progress: PipelineProgress = {
		targetPages: targetPages.length,
		pagesSettled: 0,
		pagesSucceeded: 0,
		pagesFailed: 0,
		cacheHits: 0,
		candidates: 0,
		classified: 0,
		confirmed: 0,
		unknown: 0,
	};
	const metrics: PipelineMetrics = {
		startedAt: Date.now(),
		finishedAt: 0,
		pageRequests: 0,
		cacheHits: 0,
		peakPageConcurrency: 0,
		peakClassificationConcurrency: 0,
	};
	const classified: ClassifiedReply[] = [];
	const failedPages: FailedPage[] = [];
	const seen = new Set<string>();
	const queue = new AsyncBoundedQueue<DateReplyPost>(queueCapacity);
	let pageCursor = 0;
	let pageActive = 0;
	let classifyActive = 0;

	const emit = () => onProgress?.({ ...progress });
	const classifierWorker = async () => {
		try {
			while (true) {
				if (signal?.aborted) throw abortError();
				const post = await queue.shift(signal);
				if (!post) return;
				classifyActive++;
				metrics.peakClassificationConcurrency = Math.max(
					metrics.peakClassificationConcurrency,
					classifyActive,
				);
				let result: ClassifiedReply;
				try {
					result = { post, kind: await classify(post, signal) };
				} catch (error) {
					if (isAbortError(error) || signal?.aborted) throw abortError();
					result = {
						post,
						kind: "unknown",
						error: error instanceof Error ? error.message : String(error),
					};
				} finally {
					classifyActive--;
				}
				classified.push(result);
				progress.classified++;
				if (result.kind === "floor" || result.kind === "nested") {
					progress.confirmed++;
					metrics.firstConfirmedAt ??= Date.now();
				} else if (result.kind === "unknown") progress.unknown++;
				await onClassified?.(result);
				emit();
			}
		} catch (error) {
			queue.close();
			throw error;
		}
	};

	const pageWorker = async () => {
		while (true) {
			if (signal?.aborted) throw abortError();
			const index = pageCursor++;
			if (index >= targetPages.length) return;
			const page = targetPages[index];
			pageActive++;
			metrics.peakPageConcurrency = Math.max(
				metrics.peakPageConcurrency,
				pageActive,
			);
			try {
				const loaded = await loadPage(page, signal);
				if (loaded.source === "network") metrics.pageRequests++;
				else {
					metrics.cacheHits++;
					progress.cacheHits++;
				}
				progress.pagesSucceeded++;
				await onPage?.(page, "success", loaded);
				const candidates = filterDate(
					loaded.posts,
					startMs,
					endExclusiveMs,
				).filter((post) => {
					const key = postIdentity(post);
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				});
				if (candidates.length > 0) {
					metrics.firstCandidateAt ??= Date.now();
					progress.candidates += candidates.length;
					await onCandidates?.(candidates, page);
					for (const candidate of candidates)
						await queue.push(candidate, signal);
				}
			} catch (error) {
				if (isAbortError(error) || signal?.aborted) throw abortError();
				const failure: FailedPage = {
					page,
					attempts: 1,
					message: error instanceof Error ? error.message : String(error),
					updatedAt: Date.now(),
				};
				failedPages.push(failure);
				progress.pagesFailed++;
				await onPage?.(page, "failed", failure);
			} finally {
				pageActive--;
				progress.pagesSettled++;
				emit();
			}
		}
	};

	const classifierCount = clampInteger(classificationConcurrency, 1, 4);
	const pageWorkerCount = Math.min(
		targetPages.length,
		clampInteger(pageConcurrency, 1, 8),
	);
	const consumers = Array.from({ length: classifierCount }, () =>
		classifierWorker(),
	);
	try {
		await Promise.all(
			Array.from({ length: pageWorkerCount }, () => pageWorker()),
		);
	} finally {
		queue.close();
	}
	await Promise.all(consumers);
	metrics.finishedAt = Date.now();
	return { classified, failedPages, progress, metrics };
}

export function pageFingerprint(posts: DateReplyPost[]): string {
	return uniquePosts(posts).slice(0, 20).map(postIdentity).join("|");
}

export function pageMappingDrifted(
	previous: string | undefined,
	posts: DateReplyPost[],
): boolean {
	return previous !== undefined && previous !== pageFingerprint(posts);
}

export function createEmptyProgress(targetPages = 0): PipelineProgress {
	return {
		targetPages,
		pagesSettled: 0,
		pagesSucceeded: 0,
		pagesFailed: 0,
		cacheHits: 0,
		candidates: 0,
		classified: 0,
		confirmed: 0,
		unknown: 0,
	};
}

export function migrateHistoricalTask(
	raw: unknown,
	query: HistoricalTaskQuery,
	now = Date.now(),
): HistoricalTaskV3 | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const candidate = raw as { version?: number };
	if (candidate.version === 3) {
		const current = raw as Partial<HistoricalTaskV3>;
		if (current.query && current.pageStates && current.progress) {
			return raw as HistoricalTaskV3;
		}
	}
	if (candidate.version !== 2) return undefined;
	const legacy = raw as LegacyTaskV2;
	const pageStates: Record<string, HistoricalPageState> = {};
	for (const page of legacy.checkedPages ?? []) {
		pageStates[String(page)] = {
			status: "cached",
			updatedAt: legacy.updatedAt ?? now,
		};
	}
	for (const failure of Object.values(legacy.failedPages ?? {})) {
		pageStates[String(failure.page)] = {
			status: "failed",
			updatedAt: failure.updatedAt,
			message: failure.message,
		};
	}
	return {
		version: 3,
		query,
		createdAt: legacy.updatedAt ?? now,
		updatedAt: now,
		phase: "PARTIAL",
		snapshotId: `migrated-${legacy.updatedAt ?? now}`,
		pageStates,
		progress: {
			...createEmptyProgress(),
			pagesSucceeded: legacy.checkedPages?.length ?? 0,
			pagesFailed: Object.keys(legacy.failedPages ?? {}).length,
		},
		requiresRelocation: true,
	};
}

export function completionStatus(
	input: CompletionInput,
): "COMPLETE" | "PARTIAL" {
	return !input.boundaryUncertain &&
		input.orderingVerified &&
		input.pendingPages === 0 &&
		input.failedPages === 0 &&
		input.pendingClassifications === 0 &&
		input.unknownClassifications === 0
		? "COMPLETE"
		: "PARTIAL";
}
