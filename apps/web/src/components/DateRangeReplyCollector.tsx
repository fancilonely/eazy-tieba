import { useEffect, useMemo, useRef, useState } from "react";
import { resolveApiBaseUrl } from "../lib/backend.ts";
import {
	abortError,
	chinaDateBounds,
	collectPages,
	type DateReplyPost,
	defaultDateRange,
	type FailedPage,
	filterDate,
	isAbortError,
	locatePages,
	type PageCache,
	PageRequestError,
	replyKind,
	uniquePosts,
	withExponentialRetry,
} from "../lib/date-range-replies-core.ts";
import {
	cacheDeletePrefix,
	cacheGet,
	cachePut,
} from "../lib/date-range-replies-storage.ts";
import styles from "./DateRangeReplyCollector.module.css";

type TaskPhase =
	| "locating"
	| "collecting"
	| "classifying"
	| "paused"
	| "partial"
	| "complete";

interface TaskRecord {
	version: 2;
	query: {
		method: Method;
		id: string;
		startDate: string;
		endDate: string;
	};
	phase: TaskPhase;
	fromPage?: number;
	toPage?: number;
	checkedPages: number[];
	failedPages: Record<string, FailedPage>;
	probeCount: number;
	updatedAt: number;
}

interface Summary {
	downloaded: number;
	inPeriod: number;
	floors: number;
	nested: number;
	threads: number;
	unknown: number;
}

interface StoredResult {
	posts: DateReplyPost[];
	summary: Summary;
}

interface Props {
	method: Method;
	id: string;
}

type Method = "id" | "uid" | "un";

const EMPTY_SUMMARY: Summary = {
	downloaded: 0,
	inPeriod: 0,
	floors: 0,
	nested: 0,
	threads: 0,
	unknown: 0,
};
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_REQUEST_ATTEMPTS = 4;
const MAX_SHOWN = 500;

function taskScope(
	method: Method,
	id: string,
	startDate: string,
	endDate: string,
): string {
	return `${method}:${encodeURIComponent(id)}:${startDate}:${endDate}`;
}

function pageKey(scope: string, page: number): string {
	return `date-replies:page:${scope}:${page}`;
}

function taskKey(scope: string): string {
	return `date-replies:task:${scope}`;
}

function resultKey(scope: string): string {
	return `date-replies:result:${scope}`;
}

function firstFloorKey(threadId: string): string {
	return `date-replies:first-floor:${threadId}`;
}

function csvSafe(value: unknown): string {
	let text = String(value ?? "");
	if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
	return `"${text.replaceAll('"', '""')}"`;
}

function saveCsv(data: DateReplyPost[], startDate: string, endDate: string) {
	const lines = [
		[
			"时间（中国时区）",
			"贴吧",
			"类型",
			"内容",
			"主题 ID",
			"楼层 ID",
			"内容 ID",
			"原帖链接",
		]
			.map(csvSafe)
			.join(","),
	];
	const formatter = new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	for (const post of data) {
		const kind = post.affiliated ? "楼中楼" : "楼层回复";
		const url = `https://tieba.baidu.com/p/${encodeURIComponent(post.threadId)}?pid=${encodeURIComponent(post.cid)}#${encodeURIComponent(post.cid)}`;
		lines.push(
			[
				formatter.format(new Date(post.createTime * 1_000)),
				post.forumName,
				kind,
				post.content,
				post.threadId,
				post.postId,
				post.cid,
				url,
			]
				.map(csvSafe)
				.join(","),
		);
	}
	const blob = new Blob([`\uFEFF${lines.join("\r\n")}`], {
		type: "text/csv;charset=utf-8",
	});
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = `eztb_replies_${startDate}_${endDate}.csv`;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 4_000);
}

function firstFloorId(raw: unknown): string | null {
	if (!raw || typeof raw !== "object" || !("postList" in raw)) return null;
	const posts = (raw as { postList?: Array<{ floor?: number; id?: string }> })
		.postList;
	if (!Array.isArray(posts)) return null;
	const first = posts.find(
		(post) => Number(post.floor) === 1 && post.id != null,
	);
	return first ? String(first.id) : null;
}

function validPosts(raw: unknown): DateReplyPost[] {
	if (!Array.isArray(raw)) throw new Error("用户发言接口没有返回数组");
	for (const value of raw) {
		if (
			!value ||
			typeof value !== "object" ||
			!("createTime" in value) ||
			!Number.isFinite(value.createTime) ||
			!("threadId" in value) ||
			!("postId" in value) ||
			!("cid" in value)
		) {
			throw new Error("用户发言接口返回了缺少关键字段的记录");
		}
	}
	return raw as DateReplyPost[];
}

async function requestJson<T>(url: string, signal: AbortSignal): Promise<T> {
	return withExponentialRetry(
		async () => {
			if (signal.aborted) throw abortError();
			const attemptController = new AbortController();
			let timedOut = false;
			const relayAbort = () => attemptController.abort();
			signal.addEventListener("abort", relayAbort, { once: true });
			const timer = setTimeout(() => {
				timedOut = true;
				attemptController.abort();
			}, REQUEST_TIMEOUT_MS);
			try {
				const response = await fetch(url, {
					method: "GET",
					cache: "no-store",
					signal: attemptController.signal,
				});
				if (!response.ok) {
					throw new PageRequestError(
						`HTTP ${response.status}：${new URL(url).pathname}${new URL(url).search}`,
						{
							status: response.status,
							retryable: response.status === 429 || response.status >= 500,
						},
					);
				}
				return (await response.json()) as T;
			} catch (error) {
				if (signal.aborted) throw abortError();
				if (error instanceof PageRequestError) throw error;
				throw new PageRequestError(
					timedOut
						? `请求超时（${REQUEST_TIMEOUT_MS / 1_000} 秒）：${new URL(url).pathname}`
						: `网络请求失败：${error instanceof Error ? error.message : String(error)}`,
					{ retryable: true },
				);
			} finally {
				clearTimeout(timer);
				signal.removeEventListener("abort", relayAbort);
			}
		},
		{ maxAttempts: MAX_REQUEST_ATTEMPTS, signal },
	);
}

function buildUrl(
	baseUrl: string,
	path: string,
	query: Record<string, string>,
): string {
	const url = new URL(path, `${baseUrl.replace(/\/$/, "")}/`);
	for (const [key, value] of Object.entries(query)) {
		url.searchParams.set(key, value);
	}
	return url.toString();
}

function rangePages(fromPage: number, toPage: number): number[] {
	if (toPage < fromPage) return [];
	return Array.from(
		{ length: toPage - fromPage + 1 },
		(_, index) => fromPage + index,
	);
}

/** Independent panel; existing analysis, filters, heatmap and word cloud stay intact. */
export function DateRangeReplyCollector({ method, id }: Props) {
	const defaults = useMemo(() => defaultDateRange(), []);
	const [startDate, setStartDate] = useState(defaults.startDate);
	const [endDate, setEndDate] = useState(defaults.endDate);
	const [running, setRunning] = useState(false);
	const [progress, setProgress] = useState(
		"选择日期后开始抓取；成功页和任务进度会保存在浏览器 IndexedDB。",
	);
	const [error, setError] = useState("");
	const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY);
	const [results, setResults] = useState<DateReplyPost[]>([]);
	const [task, setTask] = useState<TaskRecord | null>(null);
	const controllerRef = useRef<AbortController | null>(null);
	const runIdRef = useRef(0);
	const taskRef = useRef<TaskRecord | null>(null);
	const scope = taskScope(method, id, startDate, endDate);

	useEffect(() => {
		const loadId = ++runIdRef.current;
		controllerRef.current?.abort();
		setRunning(false);
		setTask(null);
		taskRef.current = null;
		setResults([]);
		setSummary(EMPTY_SUMMARY);
		setError("");
		setProgress("正在读取本地断点……");
		if (!id) {
			setProgress("请先查询一个用户，再选择日期范围。");
			return;
		}
		Promise.all([
			cacheGet<TaskRecord>(taskKey(scope)),
			cacheGet<StoredResult>(resultKey(scope)),
		])
			.then(([storedTask, storedResult]) => {
				if (loadId !== runIdRef.current) return;
				if (storedTask?.version === 2) {
					setTask(storedTask);
					taskRef.current = storedTask;
					const missing = Object.keys(storedTask.failedPages).length;
					if (storedTask.phase === "complete") {
						setProgress("已从 IndexedDB 恢复完成的任务。");
					} else if (storedTask.phase === "partial") {
						setProgress(`已恢复部分完成的任务，仍缺失 ${missing} 页。`);
					} else {
						setProgress("已恢复上次进度，可继续抓取。");
					}
				} else {
					setProgress("日期范围已就绪，可以开始抓取。");
				}
				if (storedResult) {
					setResults(storedResult.posts);
					setSummary(storedResult.summary);
				}
			})
			.catch((loadError) => {
				if (loadId === runIdRef.current) {
					setError(`读取 IndexedDB 失败：${String(loadError)}`);
				}
			});
		return () => {
			controllerRef.current?.abort();
			runIdRef.current++;
		};
	}, [id, scope]);

	async function run(retryFailedOnly = false) {
		if (!id || running) return;
		let dateBounds: { startMs: number; endExclusiveMs: number };
		try {
			dateBounds = chinaDateBounds(startDate, endDate);
		} catch (dateError) {
			setError(
				dateError instanceof Error ? dateError.message : String(dateError),
			);
			return;
		}

		const controller = new AbortController();
		controllerRef.current = controller;
		const { signal } = controller;
		const runId = ++runIdRef.current;
		setRunning(true);
		setError("");

		let workingTask = await cacheGet<TaskRecord>(taskKey(scope));
		if (!workingTask || workingTask.version !== 2) {
			workingTask = {
				version: 2,
				query: { method, id, startDate, endDate },
				phase: "locating",
				checkedPages: [],
				failedPages: {},
				probeCount: 0,
				updatedAt: Date.now(),
			};
		}
		let mutation = Promise.resolve();
		const mutateTask = async (change: (current: TaskRecord) => void) => {
			mutation = mutation.then(async () => {
				change(workingTask);
				workingTask.updatedAt = Date.now();
				taskRef.current = { ...workingTask };
				setTask({ ...workingTask });
				await cachePut(taskKey(scope), workingTask);
			});
			await mutation;
		};

		try {
			const baseUrl = await resolveApiBaseUrl();
			const common = { method, id };
			const fetchSinglePage = async (
				page: number,
				requestSignal = signal,
			): Promise<DateReplyPost[]> => {
				const raw = await requestJson<unknown>(
					buildUrl(baseUrl, "/user/posts", {
						...common,
						page: String(page),
					}),
					requestSignal,
				);
				return validPosts(raw);
			};
			const pageCache: PageCache = {
				get: (page) => cacheGet<DateReplyPost[]>(pageKey(scope, page)),
				put: async (page, posts) => {
					await cachePut(pageKey(scope, page), posts);
					await mutateTask((current) => {
						if (!current.checkedPages.includes(page)) {
							current.checkedPages = [...current.checkedPages, page].sort(
								(left, right) => left - right,
							);
						}
						delete current.failedPages[String(page)];
					});
				},
				markFailed: async (failure) => {
					await mutateTask((current) => {
						current.failedPages[String(failure.page)] = {
							...failure,
							attempts: MAX_REQUEST_ATTEMPTS,
						};
					});
				},
				clearFailed: async (page) => {
					await mutateTask((current) => {
						delete current.failedPages[String(page)];
						if (!current.checkedPages.includes(page)) {
							current.checkedPages = [...current.checkedPages, page].sort(
								(left, right) => left - right,
							);
						}
					});
				},
			};
			const getPageForLocation = async (page: number) => {
				const cached = await pageCache.get(page);
				if (cached !== undefined) return cached;
				try {
					const posts = await fetchSinglePage(page);
					await pageCache.put(page, posts);
					return posts;
				} catch (pageError) {
					if (isAbortError(pageError)) throw pageError;
					await pageCache.markFailed({
						page,
						attempts: MAX_REQUEST_ATTEMPTS,
						message:
							pageError instanceof Error
								? pageError.message
								: String(pageError),
						updatedAt: Date.now(),
					});
					throw pageError;
				}
			};

			if (
				workingTask.fromPage === undefined ||
				workingTask.toPage === undefined
			) {
				if (retryFailedOnly) {
					const probeFailures = Object.keys(workingTask.failedPages).map(
						Number,
					);
					if (probeFailures.length > 0) {
						setProgress(`正在重试 ${probeFailures.length} 个定位失败页……`);
						await collectPages({
							pages: probeFailures,
							fetchPage: fetchSinglePage,
							cache: pageCache,
							concurrency: 2,
							signal,
						});
					}
				}
				setProgress("正在指数跳页并二分定位日期边界……");
				const located = await locatePages(
					getPageForLocation,
					dateBounds.startMs,
					dateBounds.endExclusiveMs,
					setProgress,
				);
				if (located.unresolved) {
					await mutateTask((current) => {
						delete current.fromPage;
						delete current.toPage;
						current.probeCount = located.probeCount;
						current.phase = "partial";
					});
					const missingCount = Object.keys(workingTask.failedPages).length;
					setProgress(
						`部分完成：日期边界仍无法安全定位，保留 ${missingCount} 个失败探测页。请稍后重试失败页。`,
					);
					return;
				}
				await mutateTask((current) => {
					current.fromPage = located.fromPage;
					current.toPage = located.toPage;
					current.probeCount = located.probeCount;
					current.phase = "collecting";
					for (const page of Object.keys(current.failedPages).map(Number)) {
						if (page < located.fromPage || page > located.toPage) {
							delete current.failedPages[String(page)];
						}
					}
				});
			}

			const fromPage = workingTask.fromPage;
			const toPage = workingTask.toPage;
			if (fromPage === undefined || toPage === undefined) {
				throw new Error("任务缺少日期页码边界");
			}
			const allPages = rangePages(fromPage, toPage);
			const failedPageNumbers = Object.keys(workingTask.failedPages).map(
				Number,
			);
			const pagesToFetch = retryFailedOnly ? failedPageNumbers : allPages;

			if (pagesToFetch.length > 0) {
				await mutateTask((current) => {
					current.phase = "collecting";
				});
				await collectPages({
					pages: pagesToFetch,
					fetchPage: fetchSinglePage,
					cache: pageCache,
					concurrency: 2,
					signal,
					onProgress: (completed, total, page) => {
						setProgress(
							`单页低并发抓取：${completed}/${total}（刚检查第 ${page} 页）`,
						);
					},
				});
			}

			const allPosts: DateReplyPost[] = [];
			const missingPages: number[] = [];
			for (const page of allPages) {
				const posts = await pageCache.get(page);
				if (posts === undefined) missingPages.push(page);
				else allPosts.push(...posts);
			}
			await mutateTask((current) => {
				for (const page of missingPages) {
					current.failedPages[String(page)] ??= {
						page,
						attempts: MAX_REQUEST_ATTEMPTS,
						message: "该页尚未成功保存",
						updatedAt: Date.now(),
					};
				}
				current.phase = "classifying";
			});

			const inPeriod = uniquePosts(
				filterDate(allPosts, dateBounds.startMs, dateBounds.endExclusiveMs),
			);
			setProgress(
				`已筛出 ${inPeriod.length} 条日期内记录，正在核实主题帖与回复……`,
			);
			const firstFloorMemory = new Map<string, string | null>();
			const readFirstFloor = async (
				threadId: string,
			): Promise<string | null> => {
				if (firstFloorMemory.has(threadId)) {
					return firstFloorMemory.get(threadId) ?? null;
				}
				const cached = await cacheGet<string>(firstFloorKey(threadId));
				if (cached !== undefined) {
					firstFloorMemory.set(threadId, cached);
					return cached;
				}
				try {
					const raw = await requestJson<unknown>(
						buildUrl(baseUrl, "/post/raw", { tid: threadId, page: "1" }),
						signal,
					);
					const value = firstFloorId(raw);
					firstFloorMemory.set(threadId, value);
					if (value) await cachePut(firstFloorKey(threadId), value);
					return value;
				} catch (classifyError) {
					if (isAbortError(classifyError)) throw classifyError;
					firstFloorMemory.set(threadId, null);
					return null;
				}
			};

			let floors = 0;
			let nested = 0;
			let threads = 0;
			let unknown = 0;
			const verified: DateReplyPost[] = [];
			for (let index = 0; index < inPeriod.length; index++) {
				if (signal.aborted) throw abortError();
				const post = inPeriod[index];
				const firstId = post.affiliated
					? null
					: await readFirstFloor(post.threadId);
				const kind = replyKind(post, firstId);
				if (kind === "floor") {
					floors++;
					verified.push(post);
				} else if (kind === "nested") {
					nested++;
					verified.push(post);
				} else if (kind === "thread") {
					threads++;
				} else {
					unknown++;
				}
				if (index % 10 === 0 || index === inPeriod.length - 1) {
					setProgress(
						`分类 ${index + 1}/${inPeriod.length}：确认回复 ${floors + nested}，主题帖 ${threads}，无法核实 ${unknown}`,
					);
				}
			}

			const finalSummary: Summary = {
				downloaded: allPosts.length,
				inPeriod: inPeriod.length,
				floors,
				nested,
				threads,
				unknown,
			};
			setResults(verified);
			setSummary(finalSummary);
			await cachePut(resultKey(scope), {
				posts: verified,
				summary: finalSummary,
			} satisfies StoredResult);
			const missingCount = Object.keys(workingTask.failedPages).length;
			await mutateTask((current) => {
				current.phase = missingCount === 0 ? "complete" : "partial";
			});
			if (missingCount === 0) {
				setProgress(
					`抓取完成：日期区间所有 ${allPages.length} 页均已成功检查，保留 ${verified.length} 条确认回复。`,
				);
			} else {
				setProgress(
					`部分完成：仍有 ${missingCount} 页未成功检查；当前保留 ${verified.length} 条确认回复。请使用“重试失败页”。`,
				);
			}
			if (unknown > 0) {
				setError(
					`${unknown} 条非楼中楼记录因主题首楼不可访问而无法核实，已排除，未假定为回复。`,
				);
			}
		} catch (runError) {
			if (isAbortError(runError) || signal.aborted) {
				await mutateTask((current) => {
					current.phase = "paused";
				});
				setProgress("已暂停；成功页和当前进度已保存，可继续抓取。");
			} else {
				setError(
					runError instanceof Error ? runError.message : String(runError),
				);
				setProgress("任务遇到错误；已保存成功页，可稍后继续。");
			}
		} finally {
			if (runId === runIdRef.current) setRunning(false);
		}
	}

	async function clearTask() {
		if (running) return;
		try {
			await cacheDeletePrefix(`date-replies:task:${scope}`);
			await cacheDeletePrefix(`date-replies:page:${scope}:`);
			await cacheDeletePrefix(`date-replies:result:${scope}`);
			setTask(null);
			taskRef.current = null;
			setResults([]);
			setSummary(EMPTY_SUMMARY);
			setError("");
			setProgress("已清除当前用户和日期范围的任务缓存。");
		} catch (clearError) {
			setError(`清除任务缓存失败：${String(clearError)}`);
		}
	}

	const failedPages = task
		? Object.values(task.failedPages).sort(
				(left, right) => left.page - right.page,
			)
		: [];
	const formatter = new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});

	return (
		<section className={styles.panel} aria-label="历史回复按日期抓取">
			<h3 className={styles.heading}>历史回复 · 指定日期抓取</h3>
			<p className={styles.intro}>
				使用单页独立请求和低并发抓取。HTTP
				500、429、超时会指数退避重试；失败页会跳过并保存，不会中止整个任务。
			</p>
			<div className={styles.controls}>
				<label className={styles.dateField}>
					开始日期
					<input
						className={styles.dateInput}
						type="date"
						value={startDate}
						disabled={running}
						onChange={(event) => setStartDate(event.target.value)}
					/>
				</label>
				<label className={styles.dateField}>
					结束日期
					<input
						className={styles.dateInput}
						type="date"
						value={endDate}
						disabled={running}
						onChange={(event) => setEndDate(event.target.value)}
					/>
				</label>
				<button
					className={`${styles.button} ${styles.primary}`}
					type="button"
					disabled={!id || running}
					onClick={() => void run(false)}
				>
					{task ? "继续/读取缓存" : "开始抓取"}
				</button>
				<button
					className={styles.button}
					type="button"
					disabled={running || failedPages.length === 0}
					onClick={() => void run(true)}
				>
					重试失败页{failedPages.length > 0 ? `（${failedPages.length}）` : ""}
				</button>
				<button
					className={styles.button}
					type="button"
					disabled={!running}
					onClick={() => controllerRef.current?.abort()}
				>
					暂停
				</button>
				<button
					className={`${styles.button} ${styles.danger}`}
					type="button"
					disabled={running || !task}
					onClick={() => void clearTask()}
				>
					清除此日期任务缓存
				</button>
			</div>

			<p className={styles.progress} aria-live="polite">
				{progress}
			</p>
			{task && (
				<p className={styles.note}>
					状态：
					{task.phase === "complete"
						? "抓取完成"
						: task.phase === "partial"
							? `部分完成（缺失 ${failedPages.length} 页）`
							: task.phase}
					；页码范围：{task.fromPage ?? "定位中"}–{task.toPage ?? "定位中"}
					；成功页：{task.checkedPages.length}；定位探测：{task.probeCount}
				</p>
			)}
			{failedPages.length > 0 && (
				<p className={styles.warning}>
					缺失页：{failedPages.map((failure) => failure.page).join("、")}
					。这些页未被当成“没有更多发言”。
				</p>
			)}
			{error && (
				<p className={styles.error} role="alert">
					{error}
				</p>
			)}

			<div className={styles.stats}>
				<span>下载记录：{summary.downloaded}</span>
				<span>日期内去重：{summary.inPeriod}</span>
				<span>楼层回复：{summary.floors}</span>
				<span>楼中楼：{summary.nested}</span>
				<span>排除主题帖：{summary.threads}</span>
				<span>无法核实：{summary.unknown}</span>
			</div>

			{results.length > 0 && (
				<div className={styles.results}>
					<div className={styles.resultHeader}>
						<h3>已确认的回复（{results.length}）</h3>
						<button
							className={styles.button}
							type="button"
							onClick={() => saveCsv(results, startDate, endDate)}
						>
							导出 CSV
						</button>
					</div>
					{results.length > MAX_SHOWN && (
						<p className={styles.warning}>
							页面只展示前 {MAX_SHOWN} 条，CSV 会导出全部结果。
						</p>
					)}
					<div className={styles.list}>
						{results.slice(0, MAX_SHOWN).map((post) => (
							<article
								className={styles.item}
								key={`${post.threadId}/${post.postId}/${post.cid}/${post.createTime}`}
							>
								<div className={styles.meta}>
									<span>
										{formatter.format(new Date(post.createTime * 1_000))}
									</span>
									<span>{post.forumName || "未知贴吧"}</span>
									<span>{post.affiliated ? "楼中楼" : "楼层回复"}</span>
								</div>
								<p className={styles.content}>{post.content}</p>
								<a
									className={styles.link}
									href={`https://tieba.baidu.com/p/${encodeURIComponent(post.threadId)}?pid=${encodeURIComponent(post.cid)}#${encodeURIComponent(post.cid)}`}
									target="_blank"
									rel="noreferrer"
								>
									查看原帖
								</a>
							</article>
						))}
					</div>
				</div>
			)}
		</section>
	);
}
