import { useEffect, useMemo, useRef, useState } from "react";
import { resolveApiBaseUrl } from "../lib/backend.ts";
import {
	abortError,
	completionStatus,
	createEmptyProgress,
	createFirstFloorResolver,
	createReplyClassifier,
	type DateReplyPost,
	defaultDateRange,
	type HistoricalTaskQuery,
	type HistoricalTaskV3,
	isAbortError,
	isRetryableStatus,
	locatePages,
	maxEndDateForStart,
	migrateHistoricalTask,
	PageRequestError,
	type PipelineProgress,
	pageFingerprint,
	pageMappingDrifted,
	postIdentity,
	type ReplyKind,
	RequestScheduler,
	runClassificationPool,
	runStreamingReplyPipeline,
	type StreamingPipelineResult,
	validateDateRange,
	withExponentialRetry,
} from "../lib/date-range-replies-core.ts";
import {
	cacheDeletePrefix,
	cacheEntriesPrefix,
	cacheGet,
	cachePut,
	cachePutMany,
} from "../lib/date-range-replies-storage.ts";
import styles from "./DateRangeReplyCollector.module.css";

type Method = "id" | "uid" | "un";
type RunMode = "all" | "failed" | "unknown";
type CandidateStatus = ReplyKind | "pending";

interface PersistedCandidate {
	post: DateReplyPost;
	status: CandidateStatus;
	updatedAt: number;
	error?: string;
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

function taskKey(scope: string): string {
	return `date-replies:task:${scope}`;
}

function legacyPageKey(scope: string, page: number): string {
	return `date-replies:page:${scope}:${page}`;
}

function pageKey(scope: string, snapshotId: string, page: number): string {
	return `date-replies:page:${scope}:${snapshotId}:${page}`;
}

function candidatePrefix(scope: string, snapshotId: string): string {
	return `date-replies:candidate:${scope}:${snapshotId}:`;
}

function candidateKey(
	scope: string,
	snapshotId: string,
	post: DateReplyPost,
): string {
	return `${candidatePrefix(scope, snapshotId)}${encodeURIComponent(postIdentity(post))}`;
}

function resultKey(scope: string): string {
	return `date-replies:result:${scope}`;
}

function firstFloorKey(threadId: string): string {
	return `date-replies:first-floor:${threadId}`;
}

function newSnapshotId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function rangePages(fromPage: number, toPage: number): number[] {
	if (toPage < fromPage) return [];
	return Array.from(
		{ length: toPage - fromPage + 1 },
		(_, index) => fromPage + index,
	);
}

function csvSafe(value: unknown): string {
	let text = String(value ?? "");
	if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
	return `"${text.replaceAll('"', '""')}"`;
}

function saveCsv(
	data: DateReplyPost[],
	startDate: string,
	endDate: string,
	complete: boolean,
) {
	const lines = [
		["任务状态", complete ? "COMPLETE" : "PARTIAL"].map(csvSafe).join(","),
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
		const url = `https://tieba.baidu.com/p/${encodeURIComponent(post.threadId)}?pid=${encodeURIComponent(post.cid)}#${encodeURIComponent(post.cid)}`;
		lines.push(
			[
				formatter.format(new Date(post.createTime * 1_000)),
				post.forumName,
				post.affiliated ? "楼中楼" : "楼层回复",
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

function retryAfterMs(response: Response): number | undefined {
	const value = response.headers.get("Retry-After");
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function requestJson<T>(
	url: string,
	signal: AbortSignal,
	scheduler: RequestScheduler,
): Promise<T> {
	return withExponentialRetry(
		async () =>
			scheduler.schedule(async () => {
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
						const retryAfter = retryAfterMs(response);
						throw new PageRequestError(
							`HTTP ${response.status}：${new URL(url).pathname}${new URL(url).search}`,
							{
								status: response.status,
								retryable: isRetryableStatus(response.status),
								retryAfterMs: retryAfter,
							},
						);
					}
					return (await response.json()) as T;
				} catch (requestError) {
					if (signal.aborted) throw abortError();
					if (requestError instanceof PageRequestError) throw requestError;
					throw new PageRequestError(
						timedOut
							? `请求超时（${REQUEST_TIMEOUT_MS / 1_000} 秒）：${new URL(url).pathname}`
							: `网络请求失败：${requestError instanceof Error ? requestError.message : String(requestError)}`,
						{ retryable: true },
					);
				} finally {
					clearTimeout(timer);
					signal.removeEventListener("abort", relayAbort);
				}
			}, signal),
		{
			maxAttempts: MAX_REQUEST_ATTEMPTS,
			signal,
			onRetry: (requestError) => {
				if (
					requestError instanceof PageRequestError &&
					requestError.status === 429
				) {
					scheduler.penalize(requestError.retryAfterMs ?? 2_000);
				}
			},
		},
	);
}

function buildUrl(
	baseUrl: string,
	path: string,
	query: Record<string, string>,
): string {
	const url = new URL(path, `${baseUrl.replace(/\/$/, "")}/`);
	for (const [key, value] of Object.entries(query))
		url.searchParams.set(key, value);
	return url.toString();
}

function candidateSummary(
	candidates: Map<string, PersistedCandidate>,
	downloaded: number,
): Summary {
	let floors = 0;
	let nested = 0;
	let threads = 0;
	let unknown = 0;
	for (const candidate of candidates.values()) {
		if (candidate.status === "floor") floors++;
		else if (candidate.status === "nested") nested++;
		else if (candidate.status === "thread") threads++;
		else if (candidate.status === "unknown") unknown++;
	}
	return {
		downloaded,
		inPeriod: candidates.size,
		floors,
		nested,
		threads,
		unknown,
	};
}

function confirmedPosts(
	candidates: Map<string, PersistedCandidate>,
): DateReplyPost[] {
	return [...candidates.values()]
		.filter(
			(candidate) =>
				candidate.status === "floor" || candidate.status === "nested",
		)
		.map((candidate) => candidate.post)
		.sort((left, right) => right.createTime - left.createTime);
}

function progressFromState(
	task: HistoricalTaskV3,
	candidates: Map<string, PersistedCandidate>,
): PipelineProgress {
	const pages = task.boundary
		? rangePages(task.boundary.fromPage, task.boundary.toPage)
		: [];
	let pagesSucceeded = 0;
	let pagesFailed = 0;
	let cacheHits = 0;
	for (const page of pages) {
		const status = task.pageStates[String(page)]?.status;
		if (status === "failed") pagesFailed++;
		else if (status) {
			pagesSucceeded++;
			if (status === "cached" || status === "located") cacheHits++;
		}
	}
	let classified = 0;
	let confirmed = 0;
	let unknown = 0;
	for (const candidate of candidates.values()) {
		if (candidate.status !== "pending") classified++;
		if (candidate.status === "floor" || candidate.status === "nested")
			confirmed++;
		if (candidate.status === "unknown") unknown++;
	}
	return {
		targetPages: pages.length,
		pagesSettled: pagesSucceeded + pagesFailed,
		pagesSucceeded,
		pagesFailed,
		cacheHits,
		candidates: candidates.size,
		classified,
		confirmed,
		unknown,
	};
}

function failedPageNumbers(task: HistoricalTaskV3): number[] {
	return Object.entries(task.pageStates)
		.filter(([, state]) => state.status === "failed")
		.map(([page]) => Number(page))
		.sort((left, right) => left - right);
}

/** Independent panel; original analysis, filters, heatmap and word cloud stay intact. */
export function DateRangeReplyCollector({ method, id }: Props) {
	const defaults = useMemo(() => defaultDateRange(), []);
	const [startDate, setStartDate] = useState(defaults.startDate);
	const [endDate, setEndDate] = useState(defaults.endDate);
	const [pageConcurrency, setPageConcurrency] = useState(6);
	const [classificationConcurrency, setClassificationConcurrency] = useState(3);
	const [running, setRunning] = useState(false);
	const [message, setMessage] = useState("请选择不超过一个自然月的日期范围。");
	const [error, setError] = useState("");
	const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY);
	const [results, setResults] = useState<DateReplyPost[]>([]);
	const [task, setTask] = useState<HistoricalTaskV3 | null>(null);
	const [progress, setProgress] = useState<PipelineProgress>(
		createEmptyProgress(),
	);
	const controllerRef = useRef<AbortController | null>(null);
	const runIdRef = useRef(0);
	const scope = taskScope(method, id, startDate, endDate);
	const query = useMemo<HistoricalTaskQuery>(
		() => ({ method, id, startDate, endDate }),
		[method, id, startDate, endDate],
	);
	const dateValidation = useMemo(() => {
		try {
			return { value: validateDateRange(startDate, endDate), error: "" };
		} catch (dateError) {
			return {
				value: undefined,
				error:
					dateError instanceof Error ? dateError.message : String(dateError),
			};
		}
	}, [startDate, endDate]);
	const maximumEndDate = useMemo(() => {
		try {
			return maxEndDateForStart(startDate);
		} catch {
			return undefined;
		}
	}, [startDate]);

	useEffect(() => {
		const loadId = ++runIdRef.current;
		controllerRef.current?.abort();
		setRunning(false);
		setTask(null);
		setResults([]);
		setSummary(EMPTY_SUMMARY);
		setProgress(createEmptyProgress());
		setError("");
		if (!id) {
			setMessage("请先查询一个用户。");
			return;
		}
		setMessage("正在读取 IndexedDB 断点……");
		Promise.all([
			cacheGet<unknown>(taskKey(scope)),
			cacheGet<StoredResult>(resultKey(scope)),
		])
			.then(async ([rawTask, storedResult]) => {
				if (loadId !== runIdRef.current) return;
				const restored = migrateHistoricalTask(rawTask, query);
				if (restored) {
					const entries = await cacheEntriesPrefix<PersistedCandidate>(
						candidatePrefix(scope, restored.snapshotId),
					);
					if (loadId !== runIdRef.current) return;
					const candidates = new Map(
						entries.map(({ value }) => [postIdentity(value.post), value]),
					);
					setTask(restored);
					setProgress(progressFromState(restored, candidates));
					if (candidates.size > 0) {
						setResults(confirmedPosts(candidates));
						setSummary(candidateSummary(candidates, 0));
					} else if (storedResult) {
						setResults(storedResult.posts);
						setSummary(storedResult.summary);
					}
					setMessage(
						restored.requiresRelocation
							? "检测到旧版任务；结果已保留，继续时会安全地重新定位。"
							: `已恢复 ${restored.phase} 任务。`,
					);
				} else {
					setMessage("日期范围已就绪，可以开始定位。");
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
	}, [id, query, scope]);

	async function run(mode: RunMode) {
		if (!id || running || !dateValidation.value) {
			if (!dateValidation.value) setError(dateValidation.error);
			return;
		}
		const controller = new AbortController();
		controllerRef.current = controller;
		const { signal } = controller;
		const runId = ++runIdRef.current;
		setRunning(true);
		setError("");

		let workingTask: HistoricalTaskV3 | undefined;
		const requireWorkingTask = (): HistoricalTaskV3 => {
			if (!workingTask) throw new Error("任务尚未初始化");
			return workingTask;
		};
		let mutation = Promise.resolve();
		const mutateTask = async (change: (current: HistoricalTaskV3) => void) => {
			if (!workingTask) throw new Error("任务尚未初始化");
			mutation = mutation.then(async () => {
				if (!workingTask) return;
				change(workingTask);
				workingTask.updatedAt = Date.now();
				setTask({ ...workingTask });
				await cachePut(taskKey(scope), workingTask);
			});
			await mutation;
		};

		try {
			const rawTask = await cacheGet<unknown>(taskKey(scope));
			workingTask = migrateHistoricalTask(rawTask, query) ?? {
				version: 3,
				query,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				phase: "LOCATING",
				snapshotId: newSnapshotId(),
				pageStates: {},
				progress: createEmptyProgress(),
			};
			if (workingTask.requiresRelocation) {
				workingTask.snapshotId = newSnapshotId();
				workingTask.pageStates = {};
				workingTask.progress = createEmptyProgress();
				workingTask.boundary = undefined;
				workingTask.anchor = undefined;
				workingTask.requiresRelocation = false;
			}
			const candidateEntries = await cacheEntriesPrefix<PersistedCandidate>(
				candidatePrefix(scope, workingTask.snapshotId),
			);
			let candidates = new Map(
				candidateEntries.map(({ value }) => [postIdentity(value.post), value]),
			);
			const scheduler = new RequestScheduler({
				requestsPerSecond: 5,
				maxConcurrent: 5,
			});
			const baseUrl = await resolveApiBaseUrl();
			let locationRequests = 0;
			let classificationRequests = 0;
			let networkFailures = 0;
			const requestPage = async (
				page: number,
				purpose: "anchor" | "locate" | "fetch",
			) => {
				if (purpose !== "fetch") locationRequests++;
				try {
					return validPosts(
						await requestJson<unknown>(
							buildUrl(baseUrl, "/user/posts", {
								method,
								id,
								page: String(page),
							}),
							signal,
							scheduler,
						),
					);
				} catch (pageError) {
					if (!isAbortError(pageError)) networkFailures++;
					throw pageError;
				}
			};
			const resolveFirstFloor = createFirstFloorResolver({
				getCached: (threadId) => cacheGet<string>(firstFloorKey(threadId)),
				load: async (threadId) => {
					classificationRequests++;
					try {
						return firstFloorId(
							await requestJson<unknown>(
								buildUrl(baseUrl, "/post/raw", { tid: threadId, page: "1" }),
								signal,
								scheduler,
							),
						);
					} catch (classificationError) {
						if (!isAbortError(classificationError)) networkFailures++;
						throw classificationError;
					}
				},
				persist: (threadId, value) => cachePut(firstFloorKey(threadId), value),
			});
			const classifyReply = createReplyClassifier(resolveFirstFloor);

			let lastViewUpdate = 0;
			const updateView = (force = false) => {
				if (!workingTask) return;
				const now = Date.now();
				if (!force && now - lastViewUpdate < 100) return;
				lastViewUpdate = now;
				const currentProgress = progressFromState(workingTask, candidates);
				workingTask.progress = currentProgress;
				setProgress(currentProgress);
				setSummary(candidateSummary(candidates, 0));
				setResults(confirmedPosts(candidates));
			};

			const persistClassification = async (result: {
				post: DateReplyPost;
				kind: ReplyKind;
				error?: string;
			}) => {
				const value: PersistedCandidate = {
					post: result.post,
					status: result.kind,
					updatedAt: Date.now(),
					...(result.error && { error: result.error }),
				};
				candidates.set(postIdentity(result.post), value);
				await cachePut(
					candidateKey(scope, requireWorkingTask().snapshotId, result.post),
					value,
				);
				updateView();
			};

			if (mode === "unknown") {
				const unknownPosts = [...candidates.values()]
					.filter((candidate) => candidate.status === "unknown")
					.map((candidate) => candidate.post);
				await mutateTask((current) => {
					current.phase = "VERIFYING";
				});
				setMessage(`正在重试 ${unknownPosts.length} 条待核验记录……`);
				await runClassificationPool({
					posts: unknownPosts,
					classify: classifyReply,
					concurrency: classificationConcurrency,
					signal,
					onClassified: persistClassification,
				});
				await finalizeTask(workingTask, candidates, undefined, mutateTask);
				updateView(true);
				setMessage("待核验记录重试完成。");
				return;
			}

			if (workingTask.anchor && workingTask.boundary) {
				try {
					const anchorPage = workingTask.anchor.page;
					const freshAnchor = await requestPage(anchorPage, "anchor");
					if (pageMappingDrifted(workingTask.anchor.fingerprint, freshAnchor)) {
						workingTask.snapshotId = newSnapshotId();
						workingTask.boundary = undefined;
						workingTask.pageStates = {};
						workingTask.progress = createEmptyProgress();
						workingTask.anchor = undefined;
						candidates = new Map();
						setResults([]);
						setSummary(EMPTY_SUMMARY);
						await cachePut(
							pageKey(scope, workingTask.snapshotId, anchorPage),
							freshAnchor,
						);
						workingTask.pageStates[String(anchorPage)] = {
							status: "located",
							updatedAt: Date.now(),
						};
						workingTask.anchor = {
							page: anchorPage,
							fingerprint: pageFingerprint(freshAnchor),
						};
						setMessage("检测到贴吧页码映射变化，已启用新快照并重新定位。");
					} else {
						await cachePut(
							pageKey(scope, workingTask.snapshotId, workingTask.anchor.page),
							freshAnchor,
						);
					}
				} catch (anchorError) {
					if (workingTask.boundary) workingTask.boundary.uncertain = true;
					setError(
						`无法验证页码锚点，本次结果不会标记 COMPLETE：${anchorError instanceof Error ? anchorError.message : String(anchorError)}`,
					);
				}
			}

			if (
				mode === "all" &&
				workingTask.boundary?.uncertain &&
				failedPageNumbers(workingTask).length === 0
			) {
				workingTask.boundary = undefined;
			}

			const getLocatedPage = async (page: number): Promise<DateReplyPost[]> => {
				const key = pageKey(scope, requireWorkingTask().snapshotId, page);
				const cached = await cacheGet<DateReplyPost[]>(key);
				if (cached !== undefined) return cached;
				const posts = await requestPage(page, "locate");
				await cachePut(key, posts);
				await mutateTask((current) => {
					current.pageStates[String(page)] = {
						status: "located",
						updatedAt: Date.now(),
					};
				});
				return posts;
			};

			if (!workingTask.boundary) {
				await mutateTask((current) => {
					current.phase = "LOCATING";
				});
				setMessage("正在指数扩张并二分定位两个日期边界……");
				const located = await locatePages(
					getLocatedPage,
					dateValidation.value.startMs,
					dateValidation.value.endExclusiveMs,
					(messageText) => setMessage(messageText),
				);
				if (located.unresolved) {
					await mutateTask((current) => {
						current.phase = "PARTIAL";
						for (const page of located.failedPages) {
							current.pageStates[String(page)] = {
								status: "failed",
								updatedAt: Date.now(),
								message: "定位探测失败",
							};
						}
					});
					setMessage("PARTIAL：无法可靠确定日期边界，请稍后重试。");
					return;
				}
				workingTask.boundary = {
					fromPage: located.fromPage,
					toPage: located.toPage,
					uncertain: located.boundaryUncertain,
					orderingVerified: located.orderingVerified,
					probeCount: located.probeCount,
					notes: located.notes,
				};
				for (const page of located.failedPages) {
					workingTask.pageStates[String(page)] = {
						status: "failed",
						updatedAt: Date.now(),
						message: "定位探测失败",
					};
				}
				const anchorPosts = await cacheGet<DateReplyPost[]>(
					pageKey(scope, workingTask.snapshotId, 1),
				);
				if (anchorPosts) {
					workingTask.anchor = {
						page: 1,
						fingerprint: pageFingerprint(anchorPosts),
					};
				}
				await mutateTask((current) => {
					current.phase = "FETCHING";
				});
			}

			const boundary = workingTask.boundary;
			if (!boundary) throw new Error("定位结果缺少页码边界");
			const allTargetPages = rangePages(boundary.fromPage, boundary.toPage);
			const targetPages =
				mode === "failed"
					? failedPageNumbers(workingTask).filter(
							(page) => page >= boundary.fromPage && page <= boundary.toPage,
						)
					: allTargetPages;
			await mutateTask((current) => {
				current.phase = "FETCHING";
				current.progress.targetPages = allTargetPages.length;
			});
			setMessage(
				`目标范围第 ${boundary.fromPage}–${boundary.toPage} 页；抓取与分类正在并行执行。`,
			);

			let classifiedSinceCheckpoint = 0;
			const pipelineResult = await runStreamingReplyPipeline({
				pages: targetPages,
				startMs: dateValidation.value.startMs,
				endExclusiveMs: dateValidation.value.endExclusiveMs,
				pageConcurrency,
				classificationConcurrency,
				queueCapacity: Math.max(60, classificationConcurrency * 30),
				signal,
				loadPage: async (page) => {
					const currentTask = requireWorkingTask();
					const key = pageKey(scope, currentTask.snapshotId, page);
					const cached = await cacheGet<DateReplyPost[]>(key);
					if (cached !== undefined) {
						return {
							posts: cached,
							source:
								currentTask.pageStates[String(page)]?.status === "located"
									? "located"
									: "cache",
						} as const;
					}
					const legacy = await cacheGet<DateReplyPost[]>(
						legacyPageKey(scope, page),
					);
					if (
						legacy !== undefined &&
						currentTask.snapshotId.startsWith("migrated-")
					) {
						return { posts: legacy, source: "cache" } as const;
					}
					const posts = await requestPage(page, "fetch");
					await cachePut(key, posts);
					return { posts, source: "network" } as const;
				},
				classify: async (post, classifySignal) => {
					const existing = candidates.get(postIdentity(post));
					if (
						existing &&
						existing.status !== "pending" &&
						existing.status !== "unknown"
					) {
						return existing.status;
					}
					return classifyReply(post, classifySignal);
				},
				onPage: async (page, status, detail) => {
					await mutateTask((current) => {
						current.pageStates[String(page)] =
							status === "failed"
								? {
										status: "failed",
										updatedAt: Date.now(),
										message: "message" in detail ? detail.message : "页面失败",
									}
								: {
										status:
											"source" in detail
												? detail.source === "network"
													? "success"
													: detail.source === "located"
														? "located"
														: "cached"
												: "cached",
										updatedAt: Date.now(),
									};
					});
					updateView();
				},
				onCandidates: async (posts) => {
					const additions: Array<{ key: string; value: PersistedCandidate }> =
						[];
					for (const post of posts) {
						const identity = postIdentity(post);
						if (candidates.has(identity)) continue;
						const value: PersistedCandidate = {
							post,
							status: "pending",
							updatedAt: Date.now(),
						};
						candidates.set(identity, value);
						additions.push({
							key: candidateKey(scope, requireWorkingTask().snapshotId, post),
							value,
						});
					}
					await cachePutMany(additions);
					updateView();
				},
				onClassified: async (classified) => {
					await persistClassification(classified);
					classifiedSinceCheckpoint++;
					if (classifiedSinceCheckpoint >= 10) {
						classifiedSinceCheckpoint = 0;
						await mutateTask((current) => {
							current.progress = progressFromState(current, candidates);
						});
					}
				},
			});
			pipelineResult.metrics.locationRequests = locationRequests;
			pipelineResult.metrics.classificationRequests = classificationRequests;
			pipelineResult.metrics.totalHttpAttempts = scheduler.stats().started;
			pipelineResult.metrics.networkFailures = networkFailures;
			workingTask.metrics = pipelineResult.metrics;
			await finalizeTask(workingTask, candidates, pipelineResult, mutateTask);
			updateView(true);
			const finalStatus = workingTask.phase;
			setMessage(
				`${finalStatus}：目标页 ${workingTask.progress.pagesSucceeded}/${workingTask.progress.targetPages}，确认回复 ${workingTask.progress.confirmed}，待核验 ${workingTask.progress.unknown}。`,
			);
			await cachePut(resultKey(scope), {
				posts: confirmedPosts(candidates),
				summary: candidateSummary(candidates, 0),
			} satisfies StoredResult);
		} catch (runError) {
			if (isAbortError(runError) || signal.aborted) {
				if (workingTask) {
					await mutateTask((current) => {
						current.phase = "PAUSED";
					});
				}
				setMessage("PAUSED：页面、候选记录和分类进度均已保存。");
			} else {
				if (workingTask) {
					await mutateTask((current) => {
						current.phase = "ERROR";
					});
				}
				setError(
					runError instanceof Error ? runError.message : String(runError),
				);
				setMessage("ERROR：任务状态已保存，可修复后继续。");
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
			await cacheDeletePrefix(`date-replies:candidate:${scope}:`);
			await cacheDeletePrefix(`date-replies:result:${scope}`);
			setTask(null);
			setResults([]);
			setSummary(EMPTY_SUMMARY);
			setProgress(createEmptyProgress());
			setError("");
			setMessage("已清除当前用户和日期范围的任务缓存；其他任务未受影响。");
		} catch (clearError) {
			setError(`清除任务缓存失败：${String(clearError)}`);
		}
	}

	const failures = task ? failedPageNumbers(task) : [];
	const complete = task?.phase === "COMPLETE";
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
			<h3 className={styles.heading}>历史回复 · 定向流式抓取</h3>
			<p className={styles.intro}>
				指数定位日期边界后只抓目标页；页面下载、日期筛选、去重、持久化和回复核验会流水并行执行。
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
						max={maximumEndDate}
						disabled={running}
						onChange={(event) => setEndDate(event.target.value)}
					/>
					<span className={styles.hint}>最晚 {maximumEndDate ?? "—"}</span>
				</label>
				<label className={styles.dateField}>
					页面并发（1–8）
					<input
						className={styles.numberInput}
						type="number"
						min={1}
						max={8}
						value={pageConcurrency}
						disabled={running}
						onChange={(event) =>
							setPageConcurrency(
								Math.max(1, Math.min(8, Number(event.target.value))),
							)
						}
					/>
				</label>
				<label className={styles.dateField}>
					核验并发（1–4）
					<input
						className={styles.numberInput}
						type="number"
						min={1}
						max={4}
						value={classificationConcurrency}
						disabled={running}
						onChange={(event) =>
							setClassificationConcurrency(
								Math.max(1, Math.min(4, Number(event.target.value))),
							)
						}
					/>
				</label>
			</div>
			{dateValidation.error && (
				<p className={styles.error}>{dateValidation.error}</p>
			)}
			<div className={styles.actions}>
				<button
					className={`${styles.button} ${styles.primary}`}
					type="button"
					disabled={!id || running || Boolean(dateValidation.error)}
					onClick={() => void run("all")}
				>
					{task ? "继续抓取" : "开始抓取"}
				</button>
				<button
					className={styles.button}
					type="button"
					disabled={running || failures.length === 0}
					onClick={() => void run("failed")}
				>
					重试失败页（{failures.length}）
				</button>
				<button
					className={styles.button}
					type="button"
					disabled={running || progress.unknown === 0}
					onClick={() => void run("unknown")}
				>
					重试待核验回复（{progress.unknown}）
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
				{message}
			</p>
			{task && (
				<div className={styles.progressGrid}>
					<span>状态：{task.phase}</span>
					<span>定位探测：{task.boundary?.probeCount ?? 0}</span>
					<span>
						目标范围：
						{task.boundary
							? `第 ${task.boundary.fromPage}–${task.boundary.toPage} 页`
							: "定位中"}
					</span>
					<span>
						目标页成功：{progress.pagesSucceeded} / {progress.targetPages}
					</span>
					<span>失败页：{progress.pagesFailed}</span>
					<span>缓存命中页：{progress.cacheHits}</span>
					<span>日期内候选：{progress.candidates}</span>
					<span>已分类：{progress.classified}</span>
					<span>已确认回复：{progress.confirmed}</span>
					<span>待核验：{progress.unknown}</span>
				</div>
			)}
			{task?.metrics && (
				<p className={styles.note}>
					性能：定位/锚点请求 {task.metrics.locationRequests ?? 0}；正式页面请求
					{task.metrics.pageRequests}；分类额外请求
					{task.metrics.classificationRequests ?? 0}；缓存命中
					{task.metrics.cacheHits}；HTTP 尝试{" "}
					{task.metrics.totalHttpAttempts ?? 0}；耗时
					{Math.max(0, task.metrics.finishedAt - task.metrics.startedAt)} ms
				</p>
			)}
			{task?.boundary?.uncertain && (
				<p className={styles.warning}>
					日期边界存在失败页或排序异常，结果不会标记 COMPLETE。
				</p>
			)}
			{failures.length > 0 && (
				<p className={styles.warning}>
					缺失页：{failures.join("、")}。错误页未被当作空页或历史终点。
				</p>
			)}
			{error && (
				<p className={styles.error} role="alert">
					{error}
				</p>
			)}

			<div className={styles.stats}>
				<span>日期内去重：{summary.inPeriod}</span>
				<span>楼层回复：{summary.floors}</span>
				<span>楼中楼：{summary.nested}</span>
				<span>排除主题帖：{summary.threads}</span>
				<span>无法核实：{summary.unknown}</span>
			</div>

			{results.length > 0 && (
				<div className={styles.results}>
					<div className={styles.resultHeader}>
						<h3>实时确认回复（{results.length}）</h3>
						<button
							className={styles.button}
							type="button"
							onClick={() => saveCsv(results, startDate, endDate, complete)}
						>
							导出 CSV（{complete ? "完整" : "部分"}）
						</button>
					</div>
					{results.length > MAX_SHOWN && (
						<p className={styles.warning}>
							页面只展示前 {MAX_SHOWN} 条，CSV 会导出全部结果。
						</p>
					)}
					<div className={styles.list}>
						{results.slice(0, MAX_SHOWN).map((post) => (
							<article className={styles.item} key={postIdentity(post)}>
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

async function finalizeTask(
	task: HistoricalTaskV3,
	candidates: Map<string, PersistedCandidate>,
	pipeline: StreamingPipelineResult | undefined,
	mutateTask: (change: (current: HistoricalTaskV3) => void) => Promise<void>,
) {
	const currentProgress = progressFromState(task, candidates);
	const pendingPages = Math.max(
		0,
		currentProgress.targetPages -
			currentProgress.pagesSucceeded -
			currentProgress.pagesFailed,
	);
	const pendingClassifications = Math.max(
		0,
		currentProgress.candidates - currentProgress.classified,
	);
	const phase = completionStatus({
		boundaryUncertain: task.boundary?.uncertain ?? true,
		orderingVerified: task.boundary?.orderingVerified ?? false,
		pendingPages,
		failedPages: currentProgress.pagesFailed,
		pendingClassifications,
		unknownClassifications: currentProgress.unknown,
	});
	await mutateTask((current) => {
		current.progress = currentProgress;
		current.phase = phase;
		if (pipeline) current.metrics = pipeline.metrics;
	});
}
