/**
 * dsh-plugin-manager-panel — browser half.
 *
 * Registers a `sidebar.footer.action` occupant: 侧边栏底部「插件管理」按钮，
 * 点击弹出插件管理器面板：
 *   - 本地自定义插件 / 官方插件两个分区
 *   - 每个插件显示功能描述、启用状态、来源与必装标记
 *   - 可管理的插件带启用/停用开关（写入用户补丁层，HMR 热重载生效）
 *   - 本地自定义插件带删除按钮
 * 数据来自宿主路由 /dsh-plugin-manager-api/*（同源 fetch）。
 * 仅依赖种子模块：react、react/jsx-runtime、@deepseek-ai/dsh-client-ui-primitives。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-manager-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		// ---- 面板样式（独立 <style>，dpm- 前缀避免冲突） ----
		const css = `
.dpm-root{width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;margin:0 -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden;text-align:left}
.dpm-root:hover,.dpm-root[data-active]{background:var(--dsw-alias-interactive-bg-hover)}
.dpm-rootLabel{white-space:nowrap;font-size:13px;overflow:hidden;text-overflow:ellipsis}
.dpm-rootCount{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}
/* 侧边栏 footer 操作槽位默认横排，多个面板按钮会互相挤压；改为竖排上下堆叠 */
[class$="footerActions"]{flex-direction:column;align-items:stretch}
.dpm-rail{width:36px;height:36px;border-radius:50%;justify-content:center;gap:0;padding:0;margin:0 auto}
.dpm-panel{position:fixed;z-index:30;width:520px;max-width:calc(100vw - 24px);max-height:76vh;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);border-radius:12px;padding:14px 14px 12px;box-sizing:border-box;font-size:13px;color:var(--dsw-alias-label-primary)}
.dpm-head{display:flex;align-items:center;gap:8px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.18))}
.dpm-headTitle{font-size:14px;font-weight:600;flex:1}
.dpm-refresh{cursor:pointer;background:0 0;border:none;color:var(--dsw-alias-label-secondary);padding:4px;border-radius:8px;display:inline-flex;align-items:center}
.dpm-refresh:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dpm-body{overflow-y:auto;margin-top:10px;display:flex;flex-direction:column;gap:14px}
.dpm-tabs{display:flex;gap:4px;margin-top:10px;padding:3px;background:var(--dsw-alias-interactive-bg-hover);border-radius:10px;flex:none}
.dpm-tab{flex:1;cursor:pointer;background:0 0;border:none;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:5px 8px;font-size:12px;font-family:inherit;white-space:nowrap;transition:background .12s,color .12s}
.dpm-tab:hover{color:var(--dsw-alias-label-primary)}
.dpm-tab[data-active]{background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);font-weight:500}
.dpm-search{margin-top:8px;position:relative;flex:none}
.dpm-searchInput{width:100%;box-sizing:border-box;background:var(--dsw-alias-interactive-bg-hover);border:1px solid transparent;border-radius:9px;color:var(--dsw-alias-label-primary);padding:6px 28px 6px 10px;font-size:12px;font-family:inherit;outline:none}
.dpm-searchInput:focus{border-color:var(--dsw-alias-border-l2)}
.dpm-searchInput::placeholder{color:var(--dsw-alias-label-tertiary)}
.dpm-searchClear{position:absolute;right:4px;top:50%;transform:translateY(-50%);cursor:pointer;background:0 0;border:none;color:var(--dsw-alias-label-tertiary);padding:2px;border-radius:6px;display:inline-flex}
.dpm-searchClear:hover{color:var(--dsw-alias-label-primary)}
.dpm-searchNote{color:var(--dsw-alias-label-tertiary);font-size:11px;margin:4px 2px 0}
.dpm-remoteRow{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:10px;border:1px solid transparent}
.dpm-remoteRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dpm-remoteSide{flex:none;display:flex;align-items:center;padding-top:2px}
.dpm-install{cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 12px;font-size:12px;font-family:inherit;white-space:nowrap}
.dpm-install:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dpm-install[disabled]{cursor:not-allowed;opacity:.55}
.dpm-install.dpm-installed{opacity:.55;cursor:default}
.dpm-install.dpm-upgrade{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dpm-install.dpm-upgrade:hover{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)}
.dpm-remoteMain{flex:1;min-width:0}
.dpm-remoteName{display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;min-width:0}
.dpm-remoteName a{color:var(--dsw-alias-label-primary);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpm-remoteName a:hover{text-decoration:underline}
.dpm-remoteDesc{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:3px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dpm-remoteMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:4px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dpm-remoteStars{color:var(--dsw-alias-state-warning-primary, #d97706);font-variant-numeric:tabular-nums}
.dpm-remoteLang{background:var(--dsw-alias-interactive-bg-hover);padding:0 6px;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dpm-remoteTopics{display:flex;gap:4px;margin-top:5px;flex-wrap:wrap}
.dpm-topic{font-size:10px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}
.dpm-remoteEmpty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:8px 2px}
.dpm-remoteLink{color:var(--dsw-alias-label-secondary);font-size:11px}
.dpm-sectionTitle{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin-bottom:6px;display:flex;align-items:center;gap:6px}
.dpm-sectionCount{color:var(--dsw-alias-label-tertiary);font-weight:400}
.dpm-row{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:10px;border:1px solid transparent}
.dpm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dpm-row[data-off]{opacity:.72}
.dpm-rowMain{flex:1;min-width:0}
.dpm-rowName{display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dpm-badge{font-size:10px;font-weight:500;padding:1px 6px;border-radius:6px;white-space:nowrap;font-family:inherit}
.dpm-badgeLocal{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);color:var(--dsw-alias-state-success-primary)}
.dpm-badgeCore{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);color:var(--dsw-alias-state-error-primary)}
.dpm-badgePreset{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dpm-badgeOrigin{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font-family:inherit}
.dpm-badgeNoise{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}
.dpm-badgeNoInstall{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-label-tertiary)}
.dpm-rowDesc{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:3px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dpm-rowWhy{color:var(--dsw-alias-state-warning-primary, #d97706);font-size:11px;margin-top:3px;line-height:1.4}
.dpm-rowMeta{color:var(--dsw-alias-label-tertiary);font-size:10px;margin-top:3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dpm-rowSide{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0}
.dpm-status{font-size:11px;font-weight:500;padding:2px 8px;border-radius:8px;white-space:nowrap}
.dpm-statusOn{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);color:var(--dsw-alias-state-success-primary)}
.dpm-statusOff{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}
.dpm-actions{display:flex;gap:4px;align-items:center}
.dpm-toggle{position:relative;width:30px;height:17px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover);border:none;cursor:pointer;padding:0;transition:background .15s;flex-shrink:0}
.dpm-toggle[data-on]{background:var(--dsw-alias-state-success-primary)}
.dpm-toggle[data-on]::after{transform:translateX(13px)}
.dpm-toggle::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:transform .15s}
.dpm-toggle[disabled]{cursor:not-allowed;opacity:.45}
.dpm-delete{cursor:pointer;background:0 0;border:none;color:var(--dsw-alias-label-tertiary);padding:3px;border-radius:6px;display:inline-flex;align-items:center}
.dpm-delete:hover{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}
.dpm-delete[disabled]{cursor:not-allowed;opacity:.35}
.dpm-note{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:2px 0}
.dpm-error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin-top:8px;word-break:break-all}
.dpm-footer{margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.18));color:var(--dsw-alias-label-tertiary);font-size:11px}
`;
		const tagId = "dsh-plugin-manager-panel/styles";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-manager-panel";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } = react;
		const { IconCordisPluginOutline14, IconRefreshOutline16, IconTrashOutline16, IconCloseOutline16, useDismissOnOutsidePointer } = primitives;
		const h = react.createElement;

		// 流式搜索防抖：输入停止 ms 毫秒后才更新值
		function useDebounced(value, ms) {
			const [debounced, setDebounced] = useState(value);
			useEffect(() => {
				const t = window.setTimeout(() => setDebounced(value), ms);
				return () => window.clearTimeout(t);
			}, [value, ms]);
			return debounced;
		}

		function PluginManagerPanel({ wide }) {
			const [open, setOpen] = useState(false);
			const [tab, setTab] = useState("installed");
			const [data, setData] = useState(null);
			const [loading, setLoading] = useState(false);
			const [busyId, setBusyId] = useState(null);
			const [error, setError] = useState("");
			const [remote, setRemote] = useState(null);
			const [remoteLoading, setRemoteLoading] = useState(false);
			const [remoteError, setRemoteError] = useState("");
			// 搜索状态：installed 即时过滤；remote 优先缓存、无命中再防抖搜 GitHub
			const [installedQuery, setInstalledQuery] = useState("");
			const [remoteQuery, setRemoteQuery] = useState("");
			const debouncedRemoteQuery = useDebounced(remoteQuery, 400);
			const [remoteSearch, setRemoteSearch] = useState(null); // {mode, items, total, query}
			const [remoteSearching, setRemoteSearching] = useState(false);
			const [remoteSearchError, setRemoteSearchError] = useState("");
			const rootRef = useRef(null);
			const btnRef = useRef(null);
			const [anchor, setAnchor] = useState();

			useLayoutEffect(() => {
				if (!open) return;
				const place = () => {
					const rect = btnRef.current?.getBoundingClientRect();
					if (rect !== void 0) setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 8 });
				};
				place();
				window.addEventListener("resize", place);
				return () => window.removeEventListener("resize", place);
			}, [open]);

			useDismissOnOutsidePointer(rootRef, open, setOpen);

			const refresh = useCallback(async () => {
				setLoading(true);
				try {
					const res = await fetch("/dsh-plugin-manager-api/plugins", { headers: { accept: "application/json" } });
					if (!res.ok) throw new Error("HTTP " + res.status);
					const j = await res.json();
					if (!j.ok) throw new Error(j.error || "查询失败");
					setData(j);
					setError("");
				} catch (e) {
					setError(String(e && e.message ? e.message : e));
				} finally {
					setLoading(false);
				}
			}, []);

			useEffect(() => {
				refresh();
				const timer = window.setInterval(refresh, 30_000);
				return () => window.clearInterval(timer);
			}, [refresh]);

			useEffect(() => {
				if (open) refresh();
			}, [open, refresh]);

			// 远程仓库拉取：完全异步、静默。带 20s 硬超时（AbortSignal），
			// 失败时若已有数据则保留旧列表并仅提示一行小字，绝不让面板/启动卡住。
			const fetchRemote = useCallback(async (silent) => {
				if (!silent) setRemoteLoading(true);
				try {
					const res = await fetch("/dsh-plugin-manager-api/remote", {
						headers: { accept: "application/json" },
						signal: AbortSignal.timeout(20_000),
					});
					const j = await res.json().catch(() => ({}));
					if (!res.ok || !j.ok) throw new Error(j.error || ("HTTP " + res.status));
					setRemote(j);
					setRemoteError(j.stale ? "GitHub 暂不可用，显示上次缓存：" + (j.fetchError || "") : "");
				} catch (e) {
					// 有旧数据时保留列表，只提示一行；无数据时才显示错误
					if (remote !== null) {
						setRemoteError("同步失败（保留上次列表）：" + String(e && e.message ? e.message : e));
					} else {
						setRemoteError(String(e && e.message ? e.message : e));
					}
				} finally {
					if (!silent) setRemoteLoading(false);
				}
			}, [remote]);

			// 首次切到「远程插件」tab 时后台静默拉取（不阻塞渲染，tab 先显示空态/旧数据）
			useEffect(() => {
				if (open && tab === "remote" && !remote && !remoteLoading) fetchRemote(true);
			}, [open, tab, remote, remoteLoading, fetchRemote]);

			// 远程搜索：防抖后调用宿主路由（宿主先搜 topic，无命中再搜 GitHub 全部）
			const remoteHits = useMemo(() => {
				const q = remoteQuery.trim().toLowerCase();
				if (!q) return null;
				const items = remote?.items || [];
				const hits = items.filter((r) => {
					return [r.fullName, r.description, r.language, (r.topics || []).join(" ")].join(" ").toLowerCase().indexOf(q) !== -1;
				});
				return hits;
			}, [remoteQuery, remote]);

			useEffect(() => {
				if (tab !== "remote") return;
				const q = debouncedRemoteQuery.trim();
				if (!q) {
					setRemoteSearch(null);
					setRemoteSearching(false);
					setRemoteSearchError("");
					return;
				}
				// 缓存列表有命中时优先展示本地结果，不请求远程
				if (remoteHits !== null && remoteHits.length > 0) {
					setRemoteSearch(null);
					setRemoteSearching(false);
					setRemoteSearchError("");
					return;
				}
				let cancelled = false;
				setRemoteSearching(true);
				fetch("/dsh-plugin-manager-api/remote/search?q=" + encodeURIComponent(q), {
					headers: { accept: "application/json" },
					signal: AbortSignal.timeout(20_000),
				})
					.then((res) => res.json().catch(() => ({})))
					.then((j) => {
						if (cancelled) return;
						if (!j.ok) throw new Error(j.error || ("HTTP " + (j.status || 502)));
						setRemoteSearch(j);
						setRemoteSearchError("");
					})
					.catch((e) => {
						if (cancelled) return;
						setRemoteSearch(null);
						setRemoteSearchError(String(e && e.message ? e.message : e));
					})
					.finally(() => {
						if (!cancelled) setRemoteSearching(false);
					});
				return () => {
					cancelled = true;
				};
			}, [tab, debouncedRemoteQuery, remoteHits]);

			// 切换 tab 时清空对应搜索框之外的状态
			useEffect(() => {
				setRemoteSearch(null);
				setRemoteSearching(false);
				setRemoteSearchError("");
			}, [tab]);

			// 已安装列表搜索：即时过滤全部字段；结果同样按「启用状态 → 名称」排序
			const installedFiltered = useMemo(() => {
				const q = installedQuery.trim().toLowerCase();
				if (!q || !data) return null;
				const all = [...(data.sections.local || []), ...(data.sections.official || [])];
				return all
					.filter((e) => {
						return [e.shortName, e.moduleName, e.description, e.category, e.originLabel, e.entryId, e.version, e.disableReason]
							.join(" ").toLowerCase().indexOf(q) !== -1;
					})
					.sort((a, b) => (Number(b.enabled) - Number(a.enabled)) || a.shortName.localeCompare(b.shortName));
			}, [installedQuery, data]);

			const post = useCallback(async (path, payload) => {
				const res = await fetch(path, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
				});
				const j = await res.json().catch(() => ({}));
				if (!res.ok || !j.ok) {
					const err = new Error(j.error || ("HTTP " + res.status));
					err.hint = j.hint || null; // 结构化失败提示（如 GitHub 超时应对办法）
					err.kind = j.kind || null;
					throw err;
				}
				return j;
			}, []);

			const toggle = useCallback(async (entryId, enabled) => {
				setBusyId(entryId);
				setError("");
				try {
					await post("/dsh-plugin-manager-api/plugins/toggle", { entryId });
					// HMR 应用需要一点点时间，稍后刷新
					window.setTimeout(refresh, 600);
				} catch (e) {
					setError(String(e && e.message ? e.message : e));
				} finally {
					setBusyId(null);
				}
			}, [post, refresh]);

			const remove = useCallback(async (entry) => {
				// 确认文案按条目类型说明实际会发生什么（不提及具体本地路径）
				const what = entry.origin === "dep"
					? "将执行 pnpm remove 卸载该依赖与其文件。"
					: "将移除：用户补丁行与插件文件（npm 安装的执行 pnpm remove；本地源码安装的删除源码目录与软链）。";
				if (!window.confirm("确定删除" + (entry.origin === "dep" ? "依赖 " : "插件 ") + entry.shortName + " 吗？\n" + what)) {
					return;
				}
				setBusyId(entry.entryId);
				setError("");
				try {
					const j = await post("/dsh-plugin-manager-api/plugins/delete", { entryId: entry.entryId });
					window.setTimeout(() => {
						refresh();
						window.alert("已删除 " + entry.shortName + (j.removed && j.removed.length ? "\n移除项：" + j.removed.join("\n") : ""));
					}, 600);
				} catch (e) {
					setError(String(e && e.message ? e.message : e));
				} finally {
					setBusyId(null);
				}
			}, [post, refresh]);

			const install = useCallback(async (repo) => {
				const spec = "github:" + repo.fullName;
				if (!window.confirm("安装远程插件 " + repo.fullName + " ？\n将执行官方默认动作：在 web profile 目录运行 pnpm add " + spec)) {
					return;
				}
				setBusyId(repo.fullName);
				setRemoteError("");
				try {
					const j = await post("/dsh-plugin-manager-api/plugins/install", { spec });
					window.setTimeout(() => {
						refresh(); // 刷新已安装列表
						fetchRemote(true); // 刷新远程列表（让安装状态/版本立即生效）
						const lines = [j.added && j.added.length ? "已安装：" + j.added.join(", ") : "依赖已安装"];
						if (j.details && j.details.length) lines.push(...j.details);
						if (j.mountedRow) {
							lines.push("已挂载到「已安装」列表，可切换启停/删除");
							setTab("installed");
						}
						window.alert(lines.join("\n"));
					}, 800);
				} catch (e) {
					const msg = String(e && e.message ? e.message : e);
					const hint = e && e.hint ? "\n\n" + e.hint : "";
					// 前缀按失败类型区分，且只出现一次（宿主返回的是原始输出，不带前缀）
					const kind = e && e.kind;
					const prefix = {
						"github-network": "GitHub 安装超时：",
						"install-timeout": "安装超时：",
						"github-other": "GitHub 安装失败：",
						"npm-other": "安装失败：",
					}[kind] || "安装失败：";
					setRemoteError(prefix + msg);
					window.alert(prefix + msg + hint);
				} finally {
					setBusyId(null);
				}
			}, [post, refresh]);

			// ---- 行渲染 ----
			const renderRow = (e) => {
				const badges = [];
				if (e.local) badges.push(h("span", { className: "dpm-badge dpm-badgeLocal", key: "local" }, "自定义"));
				else if (e.core) badges.push(h("span", { className: "dpm-badge dpm-badgeCore", key: "core" }, "核心必装"));
				if (e.origin === "preset") badges.push(h("span", { className: "dpm-badge dpm-badgePreset", key: "preset" }, "预设"));
				badges.push(h("span", { className: "dpm-badge dpm-badgeOrigin", key: "origin" }, e.originLabel));

				const side = [];
				// 未挂载依赖（dep 条目）显示「未挂载」而非「停用」，避免被误认为插件被禁用
				const statusText = e.origin === "dep" ? "未挂载" : (e.enabled ? "已启用" : "已停用");
				side.push(h("span", {
					className: "dpm-status " + (e.enabled ? "dpm-statusOn" : "dpm-statusOff"),
					key: "status",
				}, statusText));

				const actions = [];
				if (e.manageable) {
					actions.push(h("button", {
						key: "toggle",
						type: "button",
						className: "dpm-toggle",
						"data-on": e.enabled || void 0,
						"aria-label": e.enabled ? "停用" : "启用",
						title: e.enabled ? "停用" : "启用",
						disabled: busyId === e.entryId,
						onClick: () => toggle(e.entryId, !e.enabled),
					}));
				} else if (e.manageHint) {
					actions.push(h("span", { key: "hint", title: e.manageHint, style: { cursor: "help", color: "var(--dsw-alias-label-tertiary)" } }, "🔒"));
				}
				if (e.local && !e.core) {
					actions.push(h("button", {
						key: "del",
						type: "button",
						className: "dpm-delete",
						"aria-label": "删除",
						title: "删除此插件",
						disabled: busyId === e.entryId,
						onClick: () => remove(e),
					}, h(IconTrashOutline16, { size: 14 })));
				}
				side.push(h("div", { className: "dpm-actions", key: "actions" }, ...actions));

				const name = h("div", { className: "dpm-rowName" },
					h("span", { key: "n" }, e.shortName),
					badges
				);
				const desc = h("div", { className: "dpm-rowDesc", key: "d" }, e.description);
				const why = !e.enabled && e.disableReason ? h("div", { className: "dpm-rowWhy", key: "w" }, "停用原因：" + e.disableReason) : null;
				const meta = h("div", { className: "dpm-rowMeta", key: "m" },
					(e.version ? "v" + e.version + " · " : "") + e.entryId + (e.fiberPhase ? " · " + e.fiberPhase : ""));
				return h("div", {
					className: "dpm-row",
					key: e.entryId,
					"data-off": !e.enabled || void 0,
					title: e.entryId,
				},
					h("div", { className: "dpm-rowMain" }, name, desc, why, meta),
					h("div", { className: "dpm-rowSide" }, ...side)
				);
			};

			const section = (title, count, list) => h("div", { className: "dpm-section", key: title },
				h("div", { className: "dpm-sectionTitle" },
					h("span", null, title),
					h("span", { className: "dpm-sectionCount" }, count + " 个")
				),
				list.map(renderRow)
			);

			const fmtNum = (n) => {
				n = Number(n) || 0;
				if (n >= 1e4) return (n / 1e4).toFixed(1) + "万";
				return String(n);
			};
			const fmtDay = (iso) => {
				if (!iso) return "";
				try {
					const d = new Date(iso);
					const now = new Date();
					const days = Math.floor((now - d) / 86400000);
					if (days <= 0) return "今天";
					if (days < 30) return days + " 天前";
					return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
				} catch {
					return "";
				}
			};

			const renderRemoteRow = (r) => {
				const installed = !!r.installedName;
				const notInstallable = r.installable === false && !installed;
				const badges = [];
				// 绿标=名称/描述直接提到 DSH；灰标=官方 topic:dsh-plugin 收录但描述未直接提及（装前看 README）
				if (installed) badges.push(h("span", { className: "dpm-badge dpm-badgePreset", key: "inst", title: "已安装 " + (r.installedVersion || "?") }, "已安装"));
				if (notInstallable) badges.push(h("span", { className: "dpm-badge dpm-badgeNoInstall", key: "noinst", title: "非 npm/JS 生态仓库，通常无法安装为 dsh 插件" }, "不可安装"));
				if (r.relevant) badges.push(h("span", { className: "dpm-badge dpm-badgeLocal", key: "rel" }, "DSH 相关"));
				else badges.push(h("span", { className: "dpm-badge dpm-badgeNoise", key: "noise" }, "topic 收录"));
				if (r.archived) badges.push(h("span", { className: "dpm-badge dpm-badgeCore", key: "arc" }, "已归档"));
				const meta = [];
				meta.push(h("span", { className: "dpm-remoteStars", key: "s" }, "★ " + fmtNum(r.stars)));
				if (installed) {
					meta.push(h("span", { key: "iv", title: "已安装版本" }, "已装 v" + (r.installedVersion || "?")));
					if (r.needsUpgrade && r.latestVersion) meta.push(h("span", { key: "lv", title: "最新版本" }, "→ v" + r.latestVersion));
				}
				if (r.language) meta.push(h("span", { className: "dpm-remoteLang", key: "l" }, r.language));
				if (r.pushedAt) meta.push(h("span", { key: "p" }, "更新 " + fmtDay(r.pushedAt)));
				meta.push(h("span", { key: "f" }, r.forks + " fork"));
				const topics = (r.topics || []).filter((t) => t !== "dsh-plugin").slice(0, 5).map((t) =>
					h("span", { className: "dpm-topic", key: "t" }, t));
				// 按钮：未安装→安装；已安装且无新版→已安装（禁用）；有新版→升级；不可安装→禁用标记
				let installBtn;
				if (notInstallable) {
					installBtn = h("button", {
						type: "button",
						className: "dpm-install dpm-installed",
						disabled: true,
						title: "非 npm/JS 生态仓库（" + (r.language || "未知语言") + "），通常无法作为 dsh 插件安装",
					}, "不可安装");
				} else if (installed && !r.needsUpgrade) {
					installBtn = h("button", {
						type: "button",
						className: "dpm-install dpm-installed",
						disabled: true,
						title: "已安装" + (r.installedVersion ? " v" + r.installedVersion : "") + (r.latestVersion ? "（最新 v" + r.latestVersion + "）" : ""),
					}, "已安装");
				} else {
					const label = installed ? "升级" : "安装";
					installBtn = h("button", {
						type: "button",
						className: "dpm-install" + (installed ? " dpm-upgrade" : ""),
						title: (installed
							? "已安装 v" + (r.installedVersion || "?") + " → 升级到 v" + (r.latestVersion || "最新") + "：pnpm add github:" + r.fullName
							: "按官方默认动作安装：pnpm add github:" + r.fullName),
						disabled: busyId === r.fullName,
						onClick: () => install(r),
					}, busyId === r.fullName ? (installed ? "升级中…" : "安装中…") : label);
				}
				return h("div", { className: "dpm-remoteRow", key: r.fullName },
					h("div", { className: "dpm-remoteMain" },
						h("div", { className: "dpm-remoteName" },
							h("a", { href: r.htmlUrl, target: "_blank", rel: "noreferrer", key: "a" }, r.fullName),
							badges
						),
						r.description ? h("div", { className: "dpm-remoteDesc", key: "d" }, r.description) : null,
						h("div", { className: "dpm-remoteMeta", key: "m" }, ...meta),
						topics.length ? h("div", { className: "dpm-remoteTopics", key: "t" }, ...topics) : null
					),
					h("div", { className: "dpm-remoteSide", key: "side" }, installBtn)
				);
			};

			const renderRemote = () => {
				// 静默模式：无数据时只显示轻量提示；已有数据时直接展示（顶部有同步小字）
				if (!remote) {
					if (remoteLoading) return h("div", { className: "dpm-note" }, "后台同步中…");
					if (remoteError) return h("div", { className: "dpm-error" }, "远程加载失败：" + remoteError);
					return h("div", { className: "dpm-note" }, "点击右上角刷新加载远程仓库");
				}
				const q = remoteQuery.trim();
				let items = remote.items || [];
				let title = "GitHub · topic:dsh-plugin";
				let sub = items.length + " 个 · 绿标「DSH 相关」= 名称/描述直接提到 DSH；灰标「topic 收录」= 官方 topic:dsh-plugin 收录、描述未直接提及（装前看 README）";
				const notes = [];
				if (q) {
					if (remoteHits !== null && remoteHits.length > 0) {
						// 1) 缓存列表命中：优先展示
						items = remoteHits;
						title = "搜索结果 · 当前缓存列表";
						sub = items.length + " 个匹配「" + q + "」（仅缓存的 " + (remote.items || []).length + " 个仓库）";
					} else if (remoteSearch && remoteSearch.items) {
						// 2) 缓存无命中：GitHub 全量搜索结果（只搜 GitHub 仓库）
						items = remoteSearch.items;
						title = "搜索结果 · GitHub 全量" + (remoteSearch.mode === "github-all" ? "（topic 无命中，已扩大范围）" : "（topic:dsh-plugin）");
						sub = items.length + " 个匹配「" + q + "」";
					} else {
						items = [];
						if (remoteSearching) notes.push(h("div", { className: "dpm-note", key: "searching" }, "缓存无命中，正在搜索 GitHub…"));
						if (remoteSearchError) notes.push(h("div", { className: "dpm-error", key: "serr" }, "远程搜索失败：" + remoteSearchError));
					}
				} else if (remoteError) {
					notes.push(h("div", { className: "dpm-rowWhy", key: "why" }, remoteError));
				}
				if (!q || (remoteHits !== null && remoteHits.length > 0) || (!remoteSearch && !remoteSearching)) {
					notes.push(h("div", { className: "dpm-section", key: "sec" },
						h("div", { className: "dpm-sectionTitle" },
							h("span", null, title),
							h("span", { className: "dpm-sectionCount" }, sub)
						),
						items.length ? items.map(renderRemoteRow) : h("div", { className: "dpm-remoteEmpty" }, q ? "未找到匹配「" + q + "」的仓库" : "（无仓库）")
					));
				}
				return notes;
			};

			const trigger = h("button", {
				ref: btnRef,
				type: "button",
				className: "dpm-root" + (wide ? "" : " dpm-rail"),
				"aria-label": "插件管理",
				"aria-expanded": open,
				"data-active": open || void 0,
				title: "插件管理：查看/启停/删除插件",
				onClick: () => setOpen((v) => !v),
			},
				h(IconCordisPluginOutline14, { size: wide ? 16 : 18 }),
				wide ? h("span", { className: "dpm-rootLabel" }, "插件管理") : null,
				wide && data ? h("span", { className: "dpm-rootCount" },
					(data.enabledCount || 0) + "/" + data.total + " 启用") : null
			);

			const panel = open && anchor !== void 0 ? h("div", {
				className: "dpm-panel",
				style: { left: anchor.left, bottom: anchor.bottom },
			},
				h("div", { className: "dpm-head" },
					h("span", { className: "dpm-headTitle" }, "插件管理"),
					h("button", {
						type: "button",
						className: "dpm-refresh",
						"aria-label": "刷新",
						title: "刷新",
						onClick: tab === "remote" ? fetchRemote : refresh,
					}, h(IconRefreshOutline16, { size: 14 })),
					(tab === "remote" ? remoteLoading : loading) ? h("span", { className: "dpm-note" }, "刷新中…") : null
				),
				h("div", { className: "dpm-tabs" },
					h("button", {
						type: "button",
						className: "dpm-tab",
						"data-active": tab === "installed" || void 0,
						onClick: () => setTab("installed"),
					}, "已安装"),
					h("button", {
						type: "button",
						className: "dpm-tab",
						"data-active": tab === "remote" || void 0,
						onClick: () => setTab("remote"),
					}, "远程插件")
				),
				h("div", { className: "dpm-search" },
					h("input", {
						className: "dpm-searchInput",
						type: "text",
						placeholder: tab === "remote"
							? "搜索远程插件：优先当前缓存，无结果时搜索 GitHub 全部…"
							: "搜索已安装插件（名称/描述/分类/来源/ID）…",
						value: tab === "remote" ? remoteQuery : installedQuery,
						onChange: (ev) => {
							const v = ev.target.value;
							if (tab === "remote") setRemoteQuery(v);
							else setInstalledQuery(v);
						},
					}),
					(tab === "remote" ? remoteQuery : installedQuery) ? h("button", {
						type: "button",
						className: "dpm-searchClear",
						"aria-label": "清空搜索",
						title: "清空搜索",
						onClick: () => {
							if (tab === "remote") setRemoteQuery("");
							else setInstalledQuery("");
						},
					}, h(IconCloseOutline16, { size: 12 })) : null
				),
				h("div", { className: "dpm-body" },
					tab === "installed" ? [
						error ? h("div", { className: "dpm-error", key: "err" }, "加载失败：" + error) : null,
						!error && !data ? h("div", { className: "dpm-note", key: "load" }, "加载中…") : null,
						!error && data ? (installedFiltered !== null
							? (installedFiltered.length
								? h("div", { className: "dpm-section", key: "search" },
									h("div", { className: "dpm-sectionTitle" },
										h("span", null, "搜索结果"),
										h("span", { className: "dpm-sectionCount" }, installedFiltered.length + " 个匹配「" + installedQuery.trim() + "」")
									),
									installedFiltered.map(renderRow)
								)
								: h("div", { className: "dpm-note", key: "nomatch" }, "未找到匹配「" + installedQuery.trim() + "」的插件"))
							: [
								data.sections.local.length ? section("本地自定义插件", data.localCount, data.sections.local) : null,
								section("官方插件", data.officialCount, data.sections.official),
							]) : null
					] : renderRemote()
				),
				h("div", { className: "dpm-footer" },
					tab === "remote"
						? (remote
							? "来自 " + remote.source + (remote.fetchedAt ? " · 更新于 " + fmtDay(remote.fetchedAt) : "") + (remote.stale ? "（缓存）" : "")
							: "GitHub topic:dsh-plugin 远程仓库")
						: "共 " + (data ? data.total : 0) + " 个条目 · " + (data ? data.enabledCount : 0) + " 启用 · " + (data ? data.disabledCount : 0) + " 停用 · 修改写入用户补丁层，HMR 热重载即时生效")
			) : null;

			return h("div", { ref: rootRef, style: { display: "contents" } }, trigger, panel);
		}

		// ---- 插件入口 ----
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "dsh-plugin-manager-panel",
				inject: () => ({})
			}, PluginManagerPanel));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
