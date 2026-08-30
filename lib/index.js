/**
 * dsh-plugin-manager-panel — host half.
 *
 * 一个「插件管理器」侧边栏面板的宿主端：
 *
 *   GET  /dsh-plugin-manager-api/plugins    → 全量插件清单（功能描述、启用状态、
 *                                            来源层、必装/可删标记、停用原因）
 *   POST /dsh-plugin-manager-api/plugins/toggle  {entryId}  → 启用/停用
 *   POST /dsh-plugin-manager-api/plugins/delete  {entryId}  → 删除本地自定义插件
 *
 * 设计要点：
 *  - 清单直接读 Cordis Loader（与 dsh-host-plugin-inventory 同源），保证所见即运行时。
 *  - 启停与删除都写 ~/.dsh/profiles/web/cordis.patch.yml（用户补丁层）；该文件被
 *    dsh 启动时的 HMR 监听（watchUserPatches），写入后整树事务性热重载，无需重启，
 *    且补丁文件本身就是持久层，重启后依然生效。
 *  - 「本地自定义插件」= 由用户补丁层 insert 的行，或包真实路径位于用户配置的
 *    本地源码目录（DSH_LOCAL_PLUGIN_DIRS）下；这类可删除。「官方插件」= bundle/预设/
 *    运行时行，标记为必需，不可删除。
 *  - 停用原因来自各补丁层的 disabled 声明（web 层按设计停用、平台不适用、预设未装等）。
 */
import { readFileSync, writeFileSync, renameSync, realpathSync, lstatSync, rmSync, existsSync } from "node:fs";
import { join, sep, delimiter } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";

const execFileP = promisify(execFile);

export const name = "dsh-plugin-manager-panel";
export const inject = ["webServer", "loader"];

/* ---------------- 路径 ---------------- */

const HOME = homedir();
const DSH_HOME = process.env.DSH_HOME || join(HOME, ".dsh");
const PROFILE_DIR = join(DSH_HOME, "profiles", "web");
// 注意：pnpm hoisted 的共享 node_modules 在 profiles 根目录，不在 web/ 下
const PROFILE_NM = join(DSH_HOME, "profiles", "node_modules");
const PROFILE_PATCH = join(PROFILE_DIR, "cordis.patch.yml");
// 本地源码插件目录（可选）：由 DSH_LOCAL_PLUGIN_DIRS 环境变量指定（多个用路径分隔符分隔）。
// 位于这些目录下的插件视为本地自定义插件，删除时连同源码目录一并移除。
const LOCAL_PLUGIN_DIRS = (process.env.DSH_LOCAL_PLUGIN_DIRS || "")
  .split(delimiter).map((p) => p.trim()).filter(Boolean);
function isInLocalDir(p) {
  return p !== null && LOCAL_PLUGIN_DIRS.some((dir) => p === dir || p.startsWith(dir + sep));
}

const SELF_MODULE = "dsh-plugin-manager-panel";

/* ---------------- 静态分类数据 ---------------- */

/** 核心必装行：停用会破坏宿主本身，面板上禁止切换。 */
const CORE = new Set([
  "include", "timer", "llm", "session", "typert", "typert-loader", "api-gateway",
  "agent", "agent-loop", "tools", "system-prompt", "sandbox", "sandbox-policy",
  "approval", "permission", "settings", "credentials", "subprocess", "fs-sandbox",
  "fs-observation-policy", "shell-env", "storage", "storage-json", "storage-domain",
  "session-persistence-jsonl", "webserver", "web-runtime", "connection", "modules",
  "client-runtime", "api-remotes", "agent-presets", "web-startup", "host-apiproxy",
  "cordis-host-runner", "session-projection", "attachment-local", "workspace",
]);

/** 运行时管理、不在本面板切换的叶子 id（动态行或自身体）。 */
const NON_MANAGEABLE = new Set(["hmr", SELF_MODULE]);

/** 各层停用原因（按叶子 id）。 */
const DISABLE_REASONS = {
  // dsh-base 基础层
  "pwsh-sandbox": "仅 Windows 平台适用，其他平台自动停用",
  "tool-pwsh": "仅 Windows 平台适用，其他平台自动停用",
  "skill-badge": "基础层默认关闭（未启用）",
  // dsh-web-app Web 层按设计停用的宿主侧行
  "hmr": "Web 层按设计停用基础 HMR（由运行时按需动态挂载）",
  "tool-bash": "Web 宿主层按设计停用：该工具由会话 agent 预设挂载",
  "tool-jobs": "Web 宿主层按设计停用：该工具由会话 agent 预设挂载",
  "tool-fs": "Web 宿主层按设计停用：该工具由会话 agent 预设挂载",
  "tool-fs-search": "Web 宿主层按设计停用：该工具由会话 agent 预设挂载",
  "tool-str-replace-editor": "Web 宿主层按设计停用：该工具由会话 agent 预设挂载",
  "skill-filesystem": "Web 宿主层按设计停用：技能发现由会话 agent 预设挂载",
  "tool-skill": "Web 宿主层按设计停用：该工具由会话 agent 预设挂载",
  "tool-goal": "Web 宿主层按设计停用：该工具由会话 agent 预设挂载",
  "plan-mode": "Web 宿主层按设计停用：计划模式由会话 agent 预设挂载",
  "compaction-basic": "Web 宿主层按设计停用：压缩由会话 agent 预设挂载",
  "command-compact": "Web 宿主层按设计停用：/compact 由会话 agent 预设挂载",
  "tool-result-pruner": "Web 宿主层按设计停用：该工具由会话 agent 预设挂载",
  "tool-subagent-control": "Web 宿主层按设计停用：该工具由会话 agent 预设挂载",
  "tool-subagent-list-agents": "Web 宿主层按设计停用：该工具由会话 agent 预设挂载",
  "tool-subagent": "Web 宿主层按设计停用：该工具由会话 agent 预设挂载",
  "tool-subagent-fork": "Web 宿主层按设计停用：该工具由会话 agent 预设挂载",
  "workflow-worker-thread": "Web 宿主层按设计停用：引擎由会话 agent 预设挂载",
  "tool-workflow": "Web 宿主层按设计停用：该工具由会话 agent 预设挂载",
  "tool-ralph": "Web 宿主层按设计停用：该工具由会话 agent 预设挂载",
  "agent-instructions": "Web 宿主层按设计停用：指令由会话 agent 预设挂载",
  "tool-todo": "Web 宿主层按设计停用：该工具由会话 agent 预设挂载",
  "tool-web": "Web 宿主层按设计停用：该工具由会话 agent 预设挂载",
};

/** 插件功能中文说明（缺失时回退到包内 package.json 的 description）。 */
const CURATED = {
  "cordis:include": "Cordis 内置 include：组合树的根入口，把各补丁层合并为最终插件清单（核心）",
  "@deepseek-ai/cordis-plugin-timer": "定时器服务：为轮询/定时任务提供基础计时能力（核心）",
  "@deepseek-ai/cordis-plugin-hmr": "Cordis 热重载（HMR）：监听配置与补丁文件变化并实时应用，无需重启",
  "@deepseek-ai/dsh-llm": "LLM 抽象层：统一的大模型服务接口与供应商路由（核心）",
  "@deepseek-ai/dsh-session": "会话领域：会话生命周期、消息与 agent 会话状态管理（核心）",
  "@deepseek-ai/dsh-typert-registry": "Typert 类型注册中心：远程调用（Remote）服务与描述符注册表（核心）",
  "@deepseek-ai/dsh-typert-loader": "Typert 描述符加载器：加载各插件声明的 Remote 接口定义",
  "@deepseek-ai/dsh-api-gateway": "API 网关：传输无关的统一分发入口，浏览器与 CLI 共用（核心）",
  "@deepseek-ai/dsh-session-title": "会话标题（兜底）：按首条消息生成简短标题",
  "@deepseek-ai/dsh-session-title-first-prompt-llm": "会话标题（LLM）：用大模型生成更智能的标题",
  "@deepseek-ai/dsh-user-questions": "用户提问服务：向用户发起带选项的确认问题（ask_user_question 后端）",
  "@deepseek-ai/dsh-agent": "Agent 接口与注册表：会话内 agent 的创建、事件与作用域（核心）",
  "@deepseek-ai/dsh-agent-default-model": "默认模型：新 agent 默认使用 deepseek-official / deepseek-v4-flash",
  "@deepseek-ai/dsh-jobs-local": "后台任务注册表（本地）：run_in_background 等后台任务的登记与查询",
  "@deepseek-ai/dsh-llm-retry": "LLM 请求重试：请求失败/限流时的自动重试策略",
  "@deepseek-ai/dsh-settings-file": "用户设置文档：~/.dsh/settings.yaml 的读写与热重载",
  "@deepseek-ai/dsh-credentials-local": "凭证存储（本地）：~/.dsh/.credentials.yaml 与环境变量中的 API Key 解析",
  "@deepseek-ai/dsh-llm-pi-ai": "pi-ai 多供应商适配器：按设置注册额外模型供应商（默认休眠）",
  "@deepseek-ai/dsh-session-persistence-jsonl": "会话持久化（JSONL）：消息写入 ~/.dsh/sessions 的 zstd 压缩日志",
  "@deepseek-ai/dsh-attachment-local": "附件存储（本地）：消息图片等内容寻址的持久化字节",
  "@deepseek-ai/dsh-session-query-sqlite": "会话检索（SQLite）：默认只开精确读取，全文搜索需显式开启",
  "@deepseek-ai/dsh-session-projection": "会话投影注册表：子代理目录/会话列表等投影单元的注册",
  "@deepseek-ai/dsh-session-telemetry-otel": "会话遥测（OTLP）：默认禁用，DSH_TELEMETRY_MODE 显式开启后上报",
  "@deepseek-ai/dsh-subprocess-local": "子进程服务（本地）：创建与管控子进程的抽象",
  "@deepseek-ai/dsh-sandbox-local": "沙箱服务（本地）：进程文件访问沙箱的实现",
  "@deepseek-ai/dsh-sandbox-policy": "沙箱策略：默认 workspace-write，文件操作限制在工作区内",
  "@deepseek-ai/dsh-bash-sandbox": "Bash 沙箱：bash 命令的文件沙箱包装（非 Windows）",
  "@deepseek-ai/dsh-pwsh-sandbox": "PowerShell 沙箱（仅 Windows）",
  "@deepseek-ai/dsh-user-approval": "审批策略：越界/提权操作时向用户发起批准（默认 ask）",
  "@deepseek-ai/dsh-permission-presets": "权限预设：read-only / workspace-write / danger-full-access 三档",
  "@deepseek-ai/dsh-shell-env": "Shell 环境变量：把 DSH 运行信息注入子进程环境（如 DSH_WEB_URL）",
  "@deepseek-ai/dsh-fs-observation-policy": "文件观察策略：读写工具先读后写的约束",
  "@deepseek-ai/dsh-skill": "技能目录：Skills 注册表与按会话分层",
  "@deepseek-ai/dsh-skill-filesystem": "技能文件系统：从仓库/本地发现 SKILL.md 技能",
  "@deepseek-ai/dsh-skill-badge": "技能徽章（基础层默认关闭）",
  "@deepseek-ai/dsh-commands": "斜杠命令系统：注册并分发 /xxx 命令",
  "@deepseek-ai/dsh-command-feedback": "消息反馈命令：消息点赞/点踩",
  "@deepseek-ai/dsh-goal": "目标领域：同会话长期目标（goal）的服务",
  "@deepseek-ai/dsh-goal-round-driver": "目标轮次驱动：自动续跑目标轮次",
  "@deepseek-ai/dsh-command-goal": "/goal 命令：目标的创建/暂停/完成等",
  "@deepseek-ai/dsh-plan-mode": "计划模式：实施前先产出计划并提交审批（plan mode）",
  "@deepseek-ai/dsh-token-meter": "Token 计量：按会话统计上下文用量",
  "@deepseek-ai/dsh-compaction-basic": "上下文压缩：上下文超长时自动摘要压缩",
  "@deepseek-ai/dsh-command-compact": "/compact 命令：手动触发一次上下文压缩",
  "@deepseek-ai/dsh-subagent": "子代理注册表：子代理的登记、查询与跟进（跨会话）",
  "@deepseek-ai/dsh-subagent-spawn-in-process": "子代理生成（spawn）：进程内新会话方式创建子代理",
  "@deepseek-ai/dsh-subagent-fork-in-process": "子代理继承（fork）：继承父会话上下文的子代理",
  "@deepseek-ai/dsh-tool-subagent-report": "子代理回报通道：可续跑子代理的 report 工具注册",
  "@deepseek-ai/dsh-tool-call-timeout-policy": "工具调用超时策略",
  "@deepseek-ai/dsh-spill-local": "溢出存储（本地）：超长内容落盘",
  "@deepseek-ai/dsh-spill-policy": "溢出策略：内容超 50KB 自动溢出到文件",
  "@deepseek-ai/dsh-session-checkpoint-policy": "会话检查点：每次模型请求前持久化检查点",
  "@deepseek-ai/dsh-compaction-tool-result-pruner": "工具结果裁剪：压缩超长工具输出",
  "@deepseek-ai/dsh-repeat-tool-reminder": "重复工具提醒：连续重复调用时提醒",
  "@deepseek-ai/dsh-web": "Web 检索抽象：web_search 搜索能力注册",
  "@deepseek-ai/dsh-web-search-deepseek": "DeepSeek 搜索：通过 DeepSeek 消息接口提供 web_search",
  "@deepseek-ai/dsh-tools": "工具注册表：把工具暴露给模型的统一入口（核心）",
  "@deepseek-ai/dsh-system-prompt": "系统提示词：persona 与提示词装配（核心）",
  "@deepseek-ai/dsh-agent-loop": "Agent 主循环：模型请求→工具执行的回合驱动（核心）",
  "@deepseek-ai/dsh-fs-sandbox": "文件系统沙箱：工具读写的目录边界",
  "@deepseek-ai/dsh-llm-deepseek": "DeepSeek 官方适配器：deepseek-official 供应商的 LLM 路由",
  "@deepseek-ai/dsh-code-runtime-worker-thread": "代码运行环境（worker 线程）",
  "@deepseek-ai/dsh-storage": "存储抽象：浏览器端数据的统一读写",
  "@deepseek-ai/dsh-storage-json": "存储（JSON）：~/.dsh/storages 下的 JSON 持久化",
  "@deepseek-ai/dsh-storage-domain": "存储领域：按命名空间细分存储",
  "@deepseek-ai/dsh-message-feedback": "消息反馈：消息点赞/点踩与备注的后端",
  "@deepseek-ai/dsh-session-log-export": "会话导出：导出会话日志",
  "@deepseek-ai/dsh-workspace": "工作区：当前工作目录与会话工作区的映射",
  "@deepseek-ai/dsh-session-projection-cache": "会话投影缓存：定期写回投影数据",
  "@deepseek-ai/dsh-session-reference": "会话引用：@会话引用解析",
  "@deepseek-ai/dsh-file-reference-local": "文件引用（本地）：@路径引用解析",
  "@deepseek-ai/dsh-session-stats": "会话统计：聊天统计条目的轮次/步数统计",
  "@deepseek-ai/dsh-host-directory-picker-auto": "目录选择器（自动）：按环境选择原生或浏览方式",
  "@deepseek-ai/dsh-host-directory-picker-native": "目录选择器（原生）",
  "@deepseek-ai/dsh-client-ui-directory-picker-native": "目录选择 UI（原生）",
  "@deepseek-ai/dsh-host-plugin-inventory": "插件清单：把当前 Loader 插件条目投影给客户端（本面板数据源）",
  "@deepseek-ai/dsh-host-apiproxy": "API 代理：浏览器 /api 路由到 Remote 服务的宿主实现（核心）",
  "@deepseek-ai/dsh-cordis-host-runner": "Cordis 宿主运行器：宿主侧动态插件运行环境",
  "@deepseek-ai/dsh-web-app/startup": "Web 启动参数：解析 dsh web 的命令行参数",
  "@deepseek-ai/dsh-host-webserver": "Web 服务器：绑定 127.0.0.1:3080 提供页面与 API（核心）",
  "@deepseek-ai/dsh-web-app": "Web 应用主体：托管前端静态资源、打印访问地址（核心）",
  "@deepseek-ai/dsh-client-hmr": "客户端热重载：浏览器插件包变更自动重载",
  "@deepseek-ai/dsh-client-modules": "客户端模块表：组合 window.__DSH_BOOT__ 浏览器插件清单（核心）",
  "@deepseek-ai/dsh-client-connection": "客户端连接：浏览器 fetch/SSE 到宿主网关的传输（核心）",
  "@deepseek-ai/dsh-api-remotes": "API 远端：客户端 Remote 方法注册",
  "@deepseek-ai/dsh-client-runtime": "客户端运行时：浏览器端运行时上下文（核心）",
  "@deepseek-ai/dsh-cordis-client-runner": "Cordis 客户端运行器：浏览器侧动态插件运行",
  "@deepseek-ai/dsh-agent-presets": "Agent 预设：standard 等会话预设的发现与挂载",
  "@deepseek-ai/dsh-client-ui-theme": "主题：明暗主题与外观",
  "@deepseek-ai/dsh-client-locale": "多语言：界面文案本地化",
  "@deepseek-ai/dsh-client-ui-layout": "布局：整体页面框架",
  "@deepseek-ai/dsh-client-ui-renderer": "渲染器：消息富文本渲染",
  "@deepseek-ai/dsh-client-ui-sidebar": "侧边栏：会话列表与侧栏框架",
  "@deepseek-ai/dsh-client-ui-settings": "设置页：设置整体界面",
  "@deepseek-ai/dsh-client-ui-settings-general": "通用设置：常规设置项",
  "@deepseek-ai/dsh-client-ui-settings-models": "模型设置：配置模型供应商与 Key",
  "@deepseek-ai/dsh-client-ui-settings-plugin-inventory": "插件清单页（只读）：宿主端插件列表",
  "@deepseek-ai/dsh-client-ui-settings-plugins": "插件配置：宿主端插件配置卡片",
  "@deepseek-ai/dsh-client-ui-conversation": "会话对话界面：消息流与输入",
  "@deepseek-ai/dsh-client-ui-brand-official": "官方品牌：侧栏与对话区的品牌占位",
  "@deepseek-ai/dsh-client-ui-attachment": "附件 UI：图片等附件展示",
  "@deepseek-ai/dsh-client-ui-tool": "工具树：工具调用展示与分型视图",
  "@deepseek-ai/dsh-client-ui-cordis": "Cordis 面板 UI",
  "@deepseek-ai/dsh-client-ui-workflow-run": "工作流运行 UI：workflow 节点的独立展示",
  "@deepseek-ai/dsh-client-ui-deliverables": "产出物：每条回复底部的生成文件列表",
  "@deepseek-ai/dsh-client-ui-workspace": "工作区 UI：会话工作区展示",
  "@deepseek-ai/dsh-client-ui-input-trigger": "输入触发器：/ 与 @ 快捷面板",
  "@deepseek-ai/dsh-client-ui-commands": "命令 UI：斜杠命令选择",
  "@deepseek-ai/dsh-client-ui-skill": "技能 UI：技能选择与说明",
  "@deepseek-ai/dsh-client-ui-subagent": "子代理 UI：子代理列表/状态",
  "@deepseek-ai/dsh-client-ui-reference": "引用 UI：@ 引用来源选择",
  "@deepseek-ai/dsh-client-ui-jobs": "后台任务 UI：会话头部的任务列表",
  "@deepseek-ai/dsh-client-ui-goal": "目标 UI：输入栏的 GoalBar",
  "@deepseek-ai/dsh-client-ui-message-feedback": "消息反馈 UI：点赞/点踩按钮",
  "@deepseek-ai/dsh-client-ui-model-selection": "模型选择 UI：/model 切换",
  "@deepseek-ai/dsh-client-ui-permission-presets": "权限预设 UI：权限切换",
  "@deepseek-ai/dsh-client-ui-agent-preset": "预设选择 UI：设置中的默认预设",
  "@deepseek-ai/dsh-client-ui-plan": "计划 UI：计划模式的面板",
  "@deepseek-ai/dsh-client-ui-user-questions": "用户提问 UI：选项确认弹窗",
  "@deepseek-ai/dsh-client-ui-trajectory": "轨迹 UI：会话轨迹/步骤查看",
  "@deepseek-ai/dsh-tool-bash": "bash 工具：在沙箱内执行 shell 命令",
  "@deepseek-ai/dsh-tool-pwsh": "PowerShell 工具（仅 Windows）",
  "@deepseek-ai/dsh-tool-fs": "文件系统工具：读写文件",
  "@deepseek-ai/dsh-tool-fs-search": "文件搜索工具：glob/grep 检索",
  "@deepseek-ai/dsh-tool-str-replace-editor": "文本替换编辑器：精确字符串替换工具",
  "@deepseek-ai/dsh-tool-jobs": "后台任务工具：job_* 控制工具",
  "@deepseek-ai/dsh-tool-skill": "技能工具：加载技能指令",
  "@deepseek-ai/dsh-tool-goal": "目标工具：goal 的创建/更新",
  "@deepseek-ai/dsh-tool-ask-user": "提问工具：向用户提问（ask_user_question）",
  "@deepseek-ai/dsh-tool-todo": "任务清单工具：todo_write",
  "@deepseek-ai/dsh-tool-web": "web_search 工具：搜索互联网",
  "@deepseek-ai/dsh-tool-subagent": "子代理工具：subagent / subagent_fork 委托",
  "@deepseek-ai/dsh-tool-subagent-control": "子代理控制工具：list_agents / send_message / interrupt",
  "@deepseek-ai/dsh-tool-subagent-control/list-agents": "子代理列表工具：list_agents",
  "@deepseek-ai/dsh-workflow-worker-thread": "工作流引擎（worker 线程）：workflow 脚本执行",
  "@deepseek-ai/dsh-tool-workflow": "工作流工具：workflow 编排脚本",
  "@deepseek-ai/dsh-tool-ralph": "Ralph 循环工具：全新 agent 迭代执行",
  "@deepseek-ai/dsh-agent-instructions": "Agent 指令：加载指令提示词",
  "@deepseek-ai/dsh-persona": "人格：预设的人设提示词",
  "dsh-balance-panel": "DeepSeek 余额/用量面板：侧边栏显示余额与 token 用量（用户自定义插件）",
  "dsh-plugin-manager-panel": "插件管理器：本面板自身（用户自定义插件）",
  "dshmarket": "DSH 可视化插件市场：在 Harness 内浏览、搜索、一键安装插件（第三方 bundle 插件）",
};

/* ---------------- 小工具 ---------------- */

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/** loopback + 同源守卫（同 deepseek-balance 面板的实现）。 */
function isLoopbackRequest(req) {
  const addr = req.socket?.remoteAddress;
  if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") return false;
  const host = req.headers?.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

async function readBody(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const SAFE_NAME = /^[A-Za-z0-9@/_.:-]+$/;

function leafIdOf(entryId) {
  return String(entryId).split(":").pop();
}

/** 模块名 → 包目录（scoped 包取前两段；pnpm 装的 profile 依赖在 web/node_modules，官方依赖回退 profiles/node_modules）。 */
function packageDirOf(moduleName) {
  if (!moduleName || moduleName.startsWith("cordis:")) return null;
  const parts = moduleName.split("/");
  const pkgName = moduleName.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (!SAFE_NAME.test(pkgName)) return null;
  for (const base of [join(PROFILE_DIR, "node_modules"), PROFILE_NM]) {
    const dir = join(base, pkgName);
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  return null;
}

function readPkg(dir) {
  if (!dir) return null;
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function realpathSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** 模块的展示名：去掉 @deepseek-ai/ 前缀。 */
function shortNameOf(moduleName) {
  return moduleName.replace(/^@deepseek-ai\//, "");
}

/* ---------------- 补丁层解析 ---------------- */

/**
 * 解析一个补丁文件，返回 { rows, insertIds, overrideIds }。
 * rows 保持文件结构用于回写；insertIds/overrideIds 用于来源判定。
 * 文件含 !!js 表达式时（解析会退化为字符串），仍能读出 id/disabled 键。
 */
function parsePatchFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let rows;
  try {
    rows = parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const insertIds = new Set();
  const overrideIds = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (Array.isArray(row.insert)) {
      for (const item of row.insert) {
        if (item && typeof item.id === "string") insertIds.add(item.id);
      }
    } else if (typeof row.id === "string") {
      overrideIds.add(row.id);
    }
  }
  return { rows, insertIds, overrideIds };
}

let _patchCache = null;
let _patchParseFailed = false;
function profilePatch() {
  if (_patchCache) return _patchCache;
  const parsed = parsePatchFile(PROFILE_PATCH);
  if (parsed === null) {
    _patchParseFailed = true;
    _patchCache = { rows: [], insertIds: new Set(), overrideIds: new Set(), failed: true };
    return _patchCache;
  }
  _patchCache = parsed;
  return _patchCache;
}

/** 读取补丁文件的头部注释（用于回写时保留）。 */
function patchHeaderComment() {
  try {
    const text = readFileSync(PROFILE_PATCH, "utf8");
    const lines = [];
    for (const line of text.split("\n")) {
      if (line.trim().startsWith("#")) lines.push(line);
      else break;
    }
    return lines.join("\n") + (lines.length ? "\n" : "");
  } catch {
    return "";
  }
}

const DEFAULT_PATCH_HEADER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
`;

/** 原子写回补丁文件（tmp + rename，避免 HMR 读到半截内容）。 */
function writePatchFile(rows) {
  const header = patchHeaderComment() || DEFAULT_PATCH_HEADER;
  const body = stringify(rows, { indent: 2, lineWidth: 0 });
  writeFileSync(PROFILE_PATCH + ".tmp", header + body);
  renameSync(PROFILE_PATCH + ".tmp", PROFILE_PATCH);
}

/* ---------------- 条目分类 ---------------- */

function classify(entryId, moduleName) {
  const leaf = leafIdOf(entryId);
  const patch = profilePatch();
  const entryIdStr = String(entryId);
  const isNumericId = /^\d+$/.test(entryIdStr);

  let origin;
  if (entryIdStr === "include") origin = "root";
  else if (entryIdStr.startsWith("include:agent-presets:")) origin = "preset";
  else if (patch.insertIds.has(leaf)) origin = "profile-patch";
  else if (isNumericId) origin = "runtime";
  else origin = "bundle";

  // 第三方 bundle：通过 pnpm 安装到 profile 依赖里的 bundle（如 dshmarket），
  // 与 DeepSeek 官方发货的 bundle（dsh-base / dsh-web-app）区分开
  const inProfileDeps = moduleName in profileDeps(readProfileManifestRaw());
  const thirdPartyBundle = origin === "bundle" && inProfileDeps;

  // 本地自定义：用户补丁 insert 的行、用户安装的第三方 bundle，或包真实路径位于本地源码目录下
  const pkgDir = packageDirOf(moduleName);
  const rp = realpathSafe(pkgDir);
  const local = origin === "profile-patch" || thirdPartyBundle || isInLocalDir(rp);

  const core = CORE.has(leaf);
  const self = moduleName === SELF_MODULE;

  let manageable;
  let manageHint = null;
  if (origin === "preset") {
    manageable = false;
    manageHint = "由会话 agent 预设管理，随会话挂载";
  } else if (origin === "runtime") {
    manageable = false;
    manageHint = "运行时动态挂载";
  } else if (self) {
    manageable = false;
    manageHint = "本面板自身，请勿停用";
  } else if (core) {
    manageable = false;
    manageHint = "核心必装插件，不可停用";
  } else if (NON_MANAGEABLE.has(leaf)) {
    manageable = false;
    manageHint = leaf === "hmr" ? "由运行时按需挂载" : "本面板自身，请勿停用";
  } else {
    manageable = true;
  }

  return { leaf, origin, local, core, self, manageable, manageHint, pkgDir, thirdPartyBundle };
}

function originLabel(origin, thirdPartyBundle) {
  if (origin === "bundle") return thirdPartyBundle ? "第三方 bundle" : "官方 bundle";
  return {
    root: "组合树根",
    "profile-patch": "用户补丁层",
    preset: "agent 预设",
    runtime: "运行时",
  }[origin] ?? origin;
}

function categoryOf(moduleName) {
  // 归一化：去掉 @deepseek-ai/ 与 dsh- 前缀后再按特征归类
  const n = moduleName.replace(/^@deepseek-ai\//, "").replace(/^dsh-/, "");
  if (n.startsWith("client-ui-")) return "界面 UI";
  if (n.startsWith("dsh-tool-") || n.startsWith("tool-")) return "模型工具";
  if (n.startsWith("host-") || /^(webServer|web-runtime|connection|modules|client-runtime|api-remotes|webserver|web-app|client-connection|client-hmr|client-modules|code-runtime|cordis-host-runner)/.test(n)) return "Web 宿主/传输";
  if (n.startsWith("session-")) return "会话";
  if (n.startsWith("llm-") || n === "llm" || n.startsWith("web-search") || n === "web") return "模型/检索";
  if (/sandbox|bash-|pwsh|approval|permission|spill|fs-sandbox|fs-observation/.test(n)) return "安全/沙箱";
  if (/agent|subagent|goal|workflow|ralph|persona|instruction/.test(n)) return "Agent 能力";
  if (/storage|attachment|file-reference|message-feedback/.test(n)) return "数据存储";
  if (/client-(locale|runtime|connection|modules|hmr|cordis)|cordis-client-runner/.test(n)) return "客户端运行时";
  if (/timer|hmr|typert|api-gateway|commands?|settings|credentials|include|tools|system-prompt|agent-loop|agent$|session$|skill|jobs|token-meter|shell-env|user-questions|repeat-tool-reminder|workspace|subprocess|compaction|plan-mode/.test(n)) return "核心基础";
  return "其他";
}

/* ---------------- 清单 ---------------- */

const FIBER_PHASE = {
  0: "pending", 1: "loading", 2: "active", 3: "failed", 4: null, 5: "unloading",
};

function buildEntry(entry) {
  const moduleName = entry.options?.name ?? "?";
  const entryId = entry.id;
  const cls = classify(entryId, moduleName);
  const enabled = !entry.disabled;
  const pkg = readPkg(cls.pkgDir);

  let description = CURATED[moduleName] ?? pkg?.description ?? null;
  if (!description) description = moduleName.startsWith("cordis:")
    ? "Cordis 内置能力"
    : "（第三方插件，无说明）";

  let disableReason = null;
  if (!enabled) {
    if (cls.origin === "preset") {
      disableReason = "agent 预设声明，但对应包未安装或未启用";
    } else {
      disableReason = DISABLE_REASONS[cls.leaf] ?? "该行在补丁层被停用";
    }
  }

  return {
    entryId,
    moduleName,
    shortName: shortNameOf(moduleName),
    version: pkg?.version ?? null,
    description,
    category: categoryOf(moduleName),
    origin: cls.origin,
    originLabel: originLabel(cls.origin, cls.thirdPartyBundle),
    enabled,
    fiberPhase: entry.fiber === void 0 ? null : FIBER_PHASE[entry.fiber.state],
    required: !cls.local,
    core: cls.core,
    local: cls.local,
    manageable: cls.manageable,
    manageHint: cls.manageHint,
    disableReason,
  };
}

function buildList(ctx) {
  const entries = [];
  const mountedNames = new Set();
  for (const entry of ctx.loader.entries()) {
    if (entry.options?.group) continue;
    mountedNames.add(entry.options?.name);
    entries.push(buildEntry(entry));
  }
  // 已安装但未挂载的依赖（pnpm add 后无补丁行/非 bundle 的包）：列入本地区，可删除
  const manifest = readProfileManifestRaw();
  for (const depName of Object.keys(profileDeps(manifest))) {
    if (mountedNames.has(depName)) continue;
    const dir = installedPkgDir(depName);
    let description = null;
    if (dir) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        description = pkg.description ?? null;
      } catch {
        // 忽略
      }
    }
    entries.push({
      entryId: "dep:" + depName,
      moduleName: depName,
      shortName: shortNameOf(depName),
      version: null,
      description: description || "已通过 pnpm 安装的依赖。若为供应器/库（无 name/apply 导出，如子代理供应器），供 agent 预设引用，不可作为插件启用；仅可删除",
      category: "其他",
      origin: "dep",
      originLabel: "已安装依赖",
      enabled: false,
      fiberPhase: null,
      required: false,
      core: false,
      local: true,
      manageable: false,
      manageHint: "依赖型包（如子代理供应器），供 agent 预设使用，不可作为插件启用；仅可删除",
      disableReason: null,
    });
  }
  const local = entries.filter((e) => e.local);
  const official = entries.filter((e) => !e.local);
  // 已安装列表排序：先按启用状态（已启用在前），再按名称；本地与官方区一致
  const byKey = (a, b) => (Number(b.enabled) - Number(a.enabled)) || a.shortName.localeCompare(b.shortName);
  local.sort(byKey);
  official.sort(byKey);
  const enabledCount = entries.filter((e) => e.enabled).length;
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    total: entries.length,
    enabledCount,
    disabledCount: entries.length - enabledCount,
    localCount: local.length,
    officialCount: official.length,
    sections: { local, official },
  };
}

/* ---------------- 启停 ---------------- */

/**
 * 持久化一次启停：
 *  - 本地行（用户补丁 insert）：直接在该行上加/删 disabled 键。
 *  - 官方 bundle 行：在用户补丁层追加/更新 {id, disabled} 覆盖行（后层胜出）。
 * 写完后由 HMR 监听自动热重载生效。
 */
function persistToggle(leaf, newEnabled, local) {
  const patch = profilePatch();
  if (_patchParseFailed) {
    throw new Error("无法解析 ~/.dsh/profiles/web/cordis.patch.yml（可能含 !!js 等特殊语法），已取消修改，请手动编辑该文件");
  }
  if (!local) {
    let found = false;
    for (const row of patch.rows) {
      if (row && typeof row === "object" && !Array.isArray(row.insert) && row.id === leaf) {
        row.disabled = newEnabled ? false : true;
        found = true;
        break;
      }
    }
    if (!found) patch.rows.push({ id: leaf, disabled: newEnabled ? false : true });
  } else {
    let found = false;
    for (const row of patch.rows) {
      if (!row || typeof row !== "object" || !Array.isArray(row.insert)) continue;
      for (const item of row.insert) {
        if (item && typeof item === "object" && item.id === leaf) {
          if (newEnabled) delete item.disabled;
          else item.disabled = true;
          found = true;
        }
      }
    }
    if (!found) {
      // 行不在补丁里（理论上不会发生）：退回覆盖行写法
      patch.rows.push({ id: leaf, disabled: newEnabled ? false : true });
    }
  }
  writePatchFile(patch.rows);
  patch.insertIds = new Set();
  patch.overrideIds = new Set();
  for (const row of patch.rows) {
    if (!row || typeof row !== "object") continue;
    if (Array.isArray(row.insert)) {
      for (const item of row.insert) if (item && typeof item.id === "string") patch.insertIds.add(item.id);
    } else if (typeof row.id === "string") {
      patch.overrideIds.add(row.id);
    }
  }
}

/* ---------------- 删除 ---------------- */

function persistDelete(leaf) {
  const patch = profilePatch();
  if (_patchParseFailed) {
    throw new Error("无法解析 ~/.dsh/profiles/web/cordis.patch.yml（可能含 !!js 等特殊语法），已取消修改，请手动编辑该文件");
  }
  patch.rows = patch.rows.filter((row) => {
    if (!row || typeof row !== "object") return true;
    if (!Array.isArray(row.insert)) return row.id !== leaf;
    const kept = row.insert.filter((item) => !(item && typeof item === "object" && item.id === leaf));
    row.insert = kept;
    return kept.length > 0;
  });
  writePatchFile(patch.rows);
  patch.insertIds = new Set();
  patch.overrideIds = new Set();
  for (const row of patch.rows) {
    if (!row || typeof row !== "object") continue;
    if (Array.isArray(row.insert)) {
      for (const item of row.insert) if (item && typeof item.id === "string") patch.insertIds.add(item.id);
    } else if (typeof row.id === "string") {
      patch.overrideIds.add(row.id);
    }
  }
}

/**
 * 删除本地插件在本机的三处痕迹：
 *  1. 用户补丁层的 insert 行（HMR 卸载）
 *  2. profile node_modules 里的软链
 *  3. 本地源码目录（DSH_LOCAL_PLUGIN_DIRS）下的插件源码目录
 * 全程只允许触碰：profile 补丁文件、node_modules 软链、本地源码目录下的包目录。
 */
async function removeLocalArtifacts(moduleName, pkgDir) {
  const removed = [];
  // npm 安装的插件：从 profile 依赖里 pnpm remove（卸载文件），并移除 bundle 层记录
  const manifest = readProfileManifestRaw();
  const deps = profileDeps(manifest);
  if (moduleName in deps) {
    const r = await pnpmRemove(moduleName);
    removed.push(r.ok
      ? `pnpm remove ${moduleName}（依赖与文件已卸载）`
      : `pnpm remove 失败：${r.output}`);
    const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
    if (bundles.includes(moduleName)) {
      manifest.dsh.profile.bundles = bundles.filter((b) => b !== moduleName);
      writeProfileManifestRaw(manifest);
      removed.push("已从 bundle 层移除（下次启动不再挂载）");
    }
    return removed;
  }
  // 本地源码目录插件：删源码目录 + 软链
  const rp = realpathSafe(pkgDir);
  if (isInLocalDir(rp)) {
    rmSync(rp, { recursive: true, force: true });
    removed.push(rp);
  }
  try {
    const st = lstatSync(pkgDir);
    if (st.isSymbolicLink()) {
      rmSync(pkgDir, { force: true });
      removed.push(pkgDir + "（软链）");
    }
  } catch {
    // 链接已不存在
  }
  return removed;
}

/* ---------------- 远程插件仓库（GitHub topic: dsh-plugin） ---------------- */

const REMOTE_SEARCH_URL =
  "https://api.github.com/search/repositories?q=topic%3Adsh-plugin&sort=stars&order=desc&per_page=100";
const REMOTE_TTL_MS = 5 * 60_000; // 缓存 5 分钟，避免打爆 GitHub Search API 限流（未认证 10 次/分钟）
const REMOTE_TIMEOUT_MS = 15_000;
const REMOTE_TOPIC_URL = "https://github.com/topics/dsh-plugin";

const remoteCache = { at: 0, data: null, error: null };

/** 是否疑似真正的 DSH 插件（排除 topic 刷量的无关仓库）。 */
function isDshRelevant(repo) {
  const hay = [
    repo.full_name,
    repo.description,
    (repo.topics || []).filter((t) => t !== "dsh-plugin").join(" "),
  ].join(" ");
  return /\b(dsh|deepseek|harness)\b/i.test(hay);
}

function mapRemoteRepo(r) {
  return {
    fullName: r.full_name,
    htmlUrl: r.html_url,
    homepage: r.homepage || null,
    description: r.description || "",
    stars: Number(r.stargazers_count) || 0,
    forks: Number(r.forks_count) || 0,
    language: r.language || null,
    topics: r.topics || [],
    pushedAt: r.pushed_at || null,
    archived: !!r.archived,
    relevant: isDshRelevant(r),
  };
}

/* ---------------- 远程仓库 ↔ 已安装插件 识别 / 版本比对 ---------------- */

/** 最小 semver 比较（支持 v 前缀与 -prerelease；无法解析视为相等）。 */
function semverCompare(a, b) {
  const parse = (v) => {
    const m = String(v).match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  if (pa[3] === pb[3]) return 0;
  if (pa[3] === null) return 1; // 正式版 > 预发布
  if (pb[3] === null) return -1;
  return pa[3] < pb[3] ? -1 : 1;
}

const latestVersionCache = new Map(); // 包名 -> { at, version }，5 分钟缓存

async function resolveLatestVersion(packageName) {
  const now = Date.now();
  const cached = latestVersionCache.get(packageName);
  if (cached && now - cached.at < 300_000) return cached.version;
  let version = null;
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const j = await res.json();
      version = j?.["dist-tags"]?.latest ?? null;
    }
  } catch {
    // 网络失败 → 版本未知
  }
  latestVersionCache.set(packageName, { at: now, version });
  return version;
}

/* ---------------- 可安装性标记（远程仓库：基于真实仓库内容判定是否可挂载为插件） ---------------- */

const MOUNT_CACHE_FILE = join(DSH_HOME, "storages", "dsh-plugin-manager-cache.json");
const MOUNT_CACHE_TTL_MS = 24 * 3600 * 1000;
const RAW_BASE = "https://raw.githubusercontent.com";
const APPLY_EXPORT_RE = /(?:export\s+(?:async\s+)?(?:const|function)\s+apply\b)|(?:exports\.apply\s*=)|(?:module\.exports\.apply\s*=)|(?:export\s*\{[^}]*\bapply\b[^}]*\})/;

let mountCache = null;
function loadMountCache() {
  if (mountCache) return mountCache;
  try {
    mountCache = JSON.parse(readFileSync(MOUNT_CACHE_FILE, "utf8")) || {};
  } catch {
    mountCache = {};
  }
  return mountCache;
}
function saveMountCache() {
  try {
    writeFileSync(MOUNT_CACHE_FILE + ".tmp", JSON.stringify(mountCache));
    renameSync(MOUNT_CACHE_FILE + ".tmp", MOUNT_CACHE_FILE);
  } catch {
    // 缓存写不进去不影响功能
  }
}

async function rawFetch(spec) {
  const res = await fetch(`${RAW_BASE}/${spec}`, {
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
  });
  return res;
}

/**
 * 判定一个 GitHub 仓库是否可作为 dsh 插件安装（即其包有可挂载入口）：
 *  - 根 package.json 有 dsh 字段 → 可挂载
 *  - 否则读主入口（main / exports.default，缺省 index.js）源码，存在 apply 导出 → 可挂载
 *  - 否则（无 package.json / 无插件入口，如桌面程序、库、资产包）→ 不可挂载
 * 返回 true / false / null(未知，网络失败不阻塞)。
 */
async function checkRepoMountable(fullName) {
  const cache = loadMountCache();
  const hit = cache[fullName];
  if (hit && Date.now() - hit.at < MOUNT_CACHE_TTL_MS) return hit.mountable;
  const [owner, repo] = fullName.split("/");
  let result = null;
  try {
    const res = await rawFetch(`${owner}/${repo}/HEAD/package.json`);
    if (res.status === 404) {
      result = false;
    } else if (!res.ok) {
      result = null;
    } else {
      const pkg = await res.json().catch(() => null);
      if (!pkg || typeof pkg !== "object") {
        result = null;
      } else if (pkg.dsh !== void 0) {
        result = true;
      } else {
        const mains = [];
        if (typeof pkg.main === "string") mains.push(pkg.main);
        else if (pkg.exports && typeof pkg.exports === "object") {
          const dot = pkg.exports["."];
          if (typeof dot === "string") mains.push(dot);
          else if (dot && typeof dot === "object" && typeof dot.default === "string") mains.push(dot.default);
        }
        const candidates = [];
        for (const m of mains) {
          if (/\.[cm]?js$/.test(m)) candidates.push(m);
          else candidates.push(m + ".js", m + ".mjs", `${m}/index.js`);
        }
        if (candidates.length === 0) candidates.push("index.js");
        result = false;
        for (const c of candidates) {
          const fRes = await rawFetch(`${owner}/${repo}/HEAD/${c}`);
          if (fRes.status === 404) continue;
          if (!fRes.ok) {
            result = null;
            break;
          }
          const src = await fRes.text();
          if (APPLY_EXPORT_RE.test(src)) {
            result = true;
            break;
          }
        }
      }
    }
  } catch {
    result = null; // 网络失败 → 未知
  }
  cache[fullName] = { at: Date.now(), mountable: result };
  return result;
}

/** 为仓库列表计算 installable：true=可作为插件安装 / false=不可 / null=未知（不阻塞）。 */
async function markInstallable(items) {
  const results = new Array(items.length).fill(null);
  const BATCH = 10;
  for (let i = 0; i < items.length; i += BATCH) {
    await Promise.all(items.slice(i, i + BATCH).map(async (item, j) => {
      results[i + j] = await checkRepoMountable(item.fullName);
    }));
  }
  saveMountCache();
  return items.map((item, i) => ({ ...item, installable: results[i] }));
}

/**
 * 把安装来源/包的 repository 解析成仓库身份键（owner/repo，小写）。
 * 支持：github:owner/repo、git+https://github.com/owner/repo.git、https://github.com/owner/repo、
 *      git@github.com:owner/repo.git、owner/repo。
 */
function parseRepoKey(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^github:/, "")
    .replace(/^git\+/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "")
    .replace(/^github\.com\//, "");
  return /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(s) ? s : null;
}

/** 当前已安装的包（挂载条目 + profile 依赖），按【仓库身份】索引（不再按名字，避免同名仓库误标）。 */
function buildInstalledMap(ctx) {
  const map = new Map();
  const seenRepo = new Set();
  const add = (info) => {
    if (!info.repoKey || seenRepo.has(info.repoKey)) return;
    seenRepo.add(info.repoKey);
    map.set("repo:" + info.repoKey, info);
  };
  for (const entry of ctx.loader.entries()) {
    if (entry.options?.group) continue;
    const name = entry.options?.name;
    if (!name || name.startsWith("cordis:")) continue;
    const pkg = readPkg(packageDirOf(name));
    add({
      name,
      version: pkg?.version ?? null,
      repoKey: parseRepoKey(pkg?.repository?.url ?? pkg?.repository),
    });
  }
  const manifest = readProfileManifestRaw();
  for (const [dep, spec] of Object.entries(profileDeps(manifest))) {
    const pkg = readPkg(installedPkgDir(dep));
    add({
      name: dep,
      version: pkg?.version ?? null,
      repoKey: parseRepoKey(spec) ?? parseRepoKey(pkg?.repository?.url ?? pkg?.repository),
    });
  }
  return map;
}

/**
 * 为远程仓库条目补充安装状态与版本信息（快速路径：不做任何网络请求）：
 *  - installable：读磁盘可安装性缓存（未命中 → null，即"未知"，不阻塞、不误拦）
 *  - installedName / installedVersion：按仓库身份匹配的已安装包（同名不同仓库不会误标）
 *  - latestVersion：读内存版本缓存（重启后首次为 null，后台预热后补上）
 *  - needsUpgrade：已装版本 < 最新版本
 * 网络型富化（可安装性判定、npm 最新版）由 warmRemoteEnrichment 在后台填充。
 */
function enrichRemoteItems(ctx, items) {
  const mountCache = loadMountCache();
  const installedMap = buildInstalledMap(ctx);
  return items.map((item) => {
    const installable = mountCache[item.fullName]?.mountable ?? null;
    const hit = installedMap.get("repo:" + String(item.fullName).toLowerCase().replace(/\.git$/, ""));
    if (!hit) return { ...item, installable, installedName: null, installedVersion: null, latestVersion: null, needsUpgrade: false };
    const latest = latestVersionCache.get(hit.name)?.version ?? null;
    return {
      ...item,
      installable,
      installedName: hit.name,
      installedVersion: hit.version,
      latestVersion: latest,
      needsUpgrade: !!(hit.version && latest && semverCompare(hit.version, latest) < 0),
    };
  });
}

let warmPromise = null;

/**
 * 后台预热：网络型富化（可安装性判定→写磁盘缓存；已安装包的最新版→写内存缓存）。
 * 前台响应不等待它，因此远程列表始终秒开。
 */
function warmRemoteEnrichment(ctx, rawItems) {
  if (warmPromise) return warmPromise;
  warmPromise = (async () => {
    try {
      await markInstallable(rawItems);
      const installedMap = buildInstalledMap(ctx);
      const toResolve = new Set();
      for (const item of rawItems) {
        const hit = installedMap.get("repo:" + String(item.fullName).toLowerCase().replace(/\.git$/, ""));
        if (hit) toResolve.add(hit.name);
      }
      await Promise.all([...toResolve].map((name) => resolveLatestVersion(name)));
    } finally {
      warmPromise = null;
    }
  })();
  return warmPromise;
}

/* ---------------- 远程列表磁盘缓存（重启不重拉 GitHub） ---------------- */

const REMOTE_DISK_FILE = join(DSH_HOME, "storages", "dsh-plugin-manager-remote.json");
const REMOTE_DISK_TTL_MS = 6 * 3600 * 1000; // 磁盘缓存 6 小时；内存缓存 5 分钟内不重拉
const REMOTE_FETCH_PAGES = 3; // 翻 3 页（每页 100）→ 约 300 个候选，过滤不可安装后仍能补足 100 个可安装

/**
 * 从 GitHub 拉取 topic:dsh-plugin 仓库（多页）：
 * 返回按星数排序的原始条目列表（约 300 个候选）。
 */
async function fetchRemoteRawItems() {
  const all = [];
  for (let page = 1; page <= REMOTE_FETCH_PAGES; page++) {
    const url = `https://api.github.com/search/repositories?q=topic%3Adsh-plugin&sort=stars&order=desc&per_page=100&page=${page}`;
    const res = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "dsh-plugin-manager (dsh web profile plugin)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
    const j = await res.json();
    if (!Array.isArray(j.items)) throw new Error("GitHub API 响应缺少 items");
    all.push(...j.items.map(mapRemoteRepo));
    if (j.items.length < 100) break; // 没有更多页了
  }
  return all;
}

function loadRemoteDisk() {
  try {
    const j = JSON.parse(readFileSync(REMOTE_DISK_FILE, "utf8"));
    if (j && typeof j === "object" && Array.isArray(j.rawItems) && j.rawItems.length) return j;
  } catch {
    // 无缓存或损坏
  }
  return null;
}

function saveRemoteDisk(entry) {
  try {
    writeFileSync(REMOTE_DISK_FILE + ".tmp", JSON.stringify(entry));
    renameSync(REMOTE_DISK_FILE + ".tmp", REMOTE_DISK_FILE);
  } catch {
    // 缓存写不进去不影响功能
  }
}

/** 把磁盘/内存里的原始条目组装成一次响应（仅本地快速富化；网络型富化由后台预热填充）。 */
function remotePayload(ctx, entry) {
  warmRemoteEnrichment(ctx, entry.rawItems); // 后台预热，不阻塞响应
  const items = enrichRemoteItems(ctx, entry.rawItems);
  // 默认浏览：只展示已确认"可安装"的仓库（installable=true，含已安装/可升级），并补足到 100 个；
  // 手动搜索走独立路由，不过滤。installable=null（后台还在判定）时不展示，列表随预热自动补全。
  const TARGET = 100;
  const kept = items.filter((i) => i.installable === true).slice(0, TARGET);
  const warming = items.some((i) => i.installable === null);
  return {
    fetchedAt: entry.fetchedAt,
    total: entry.total,
    source: entry.source,
    relevantCount: entry.relevantCount,
    warming,
    filteredCount: items.length - kept.length,
    ...(entry.stale !== void 0 ? { stale: entry.stale } : {}),
    ...(entry.fetchError !== void 0 ? { fetchError: entry.fetchError } : {}),
    items: kept,
  };
}

/**
 * 拉取远程仓库列表：优先内存缓存（5 分钟）→ 磁盘缓存（6 小时，重启不重拉）→ GitHub。
 * force=true 时跳过两级缓存直接拉 GitHub（刷新按钮）。
 * 所有路径都立即返回（只做本地富化），网络型富化（可安装性/npm 版本）后台预热。
 */
async function fetchRemotePlugins(ctx, force) {
  const now = Date.now();
  if (!force && remoteCache.data && now - remoteCache.at < REMOTE_TTL_MS) {
    return remotePayload(ctx, remoteCache.data);
  }
  if (!force && remoteCache.error && now - remoteCache.at < REMOTE_TTL_MS) throw remoteCache.error;
  // 磁盘缓存兜底：重启后直接用缓存，不碰 GitHub
  if (!force) {
    const disk = loadRemoteDisk();
    // 旧格式缓存只有 100 个候选（补全逻辑上线前），不足 150 视为过期，自动重拉补足
    if (disk && now - disk.at < REMOTE_DISK_TTL_MS && disk.rawItems.length >= 150) {
      remoteCache.at = now;
      remoteCache.data = disk;
      remoteCache.error = null;
      return remotePayload(ctx, disk);
    }
  }
  try {
    const rawItems = await fetchRemoteRawItems();
    const payload = {
      fetchedAt: new Date().toISOString(),
      total: rawItems.length,
      source: REMOTE_TOPIC_URL,
      rawItems,
      relevantCount: rawItems.filter((i) => i.relevant).length,
    };
    remoteCache.at = now;
    remoteCache.data = payload;
    remoteCache.error = null;
    saveRemoteDisk({ ...payload, at: now });
    return remotePayload(ctx, payload);
  } catch (e) {
    const err = new Error(String(e?.message ?? e));
    remoteCache.at = now;
    remoteCache.error = err;
    // 有任何旧数据就降级返回（内存或磁盘），绝不让远程故障影响面板可用性
    if (remoteCache.data) return remotePayload(ctx, remoteCache.data);
    const disk = loadRemoteDisk();
    if (disk) return remotePayload(ctx, { ...disk, stale: true, fetchError: err.message });
    throw err;
  }
}

/* ---------------- 远程插件搜索（流式：先缓存列表，无命中再搜 GitHub 全部） ---------------- */

const REMOTE_SEARCH_CACHE_TTL_MS = 60_000;
const REMOTE_SEARCH_RATE_LIMIT = 8; // GitHub 未认证搜索限流 10 次/分钟，留余量
const remoteSearchCache = new Map(); // q -> { at, data }
let remoteSearchTimestamps = [];

async function githubSearchRepos(query, topicOnly) {
  // 注意：限定符与关键词之间用真实空格（encodeURIComponent 会把 + 编码成 %2B 导致查询失效）。
  // 用 GitHub 默认的"最佳匹配"排序（名字精确匹配优先，新仓库也能排上来），取 100 条。
  const qualifier = topicOnly ? `topic:dsh-plugin ${query}` : query;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(qualifier)}&per_page=100`;
  const res = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "dsh-plugin-manager (dsh web profile plugin)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const j = await res.json();
  if (!Array.isArray(j.items)) throw new Error("GitHub API 响应缺少 items");
  return j;
}

async function searchRemotePlugins(ctx, query) {
  const now = Date.now();
  // 滑动窗口限流
  remoteSearchTimestamps = remoteSearchTimestamps.filter((t) => now - t < 60_000);
  if (remoteSearchTimestamps.length >= REMOTE_SEARCH_RATE_LIMIT) {
    const err = new Error("GitHub 搜索触发限流，请稍候几秒再试");
    err.code = "RATE_LIMIT";
    throw err;
  }
  remoteSearchTimestamps.push(now);
  const cached = remoteSearchCache.get(query);
  // 搜索缓存同样存原始数据，读取时快速富化（网络富化由后台预热填充）
  if (cached && now - cached.at < REMOTE_SEARCH_CACHE_TTL_MS) {
    warmRemoteEnrichment(ctx, cached.data.rawItems);
    return {
      fetchedAt: cached.data.fetchedAt,
      query: cached.data.query,
      mode: cached.data.mode,
      total: cached.data.total,
      items: enrichRemoteItems(ctx, cached.data.rawItems),
    };
  }
  // 只搜 GitHub：先 dsh-plugin topic，无命中再搜全部 GitHub 仓库
  let j;
  let mode = "github-topic";
  try {
    j = await githubSearchRepos(query, true);
  } catch (e) {
    if (cached) {
      warmRemoteEnrichment(ctx, cached.data.rawItems);
      return {
        fetchedAt: cached.data.fetchedAt,
        query: cached.data.query,
        mode: cached.data.mode,
        total: cached.data.total,
        items: enrichRemoteItems(ctx, cached.data.rawItems),
      };
    }
    throw e;
  }
  if (!Array.isArray(j.items) || j.items.length === 0) {
    j = await githubSearchRepos(query, false);
    mode = "github-all";
  }
  const rawItems = j.items.map(mapRemoteRepo);
  warmRemoteEnrichment(ctx, rawItems);
  const data = {
    fetchedAt: new Date().toISOString(),
    query,
    mode,
    total: Number(j.total_count) || 0,
    rawItems,
    items: enrichRemoteItems(ctx, rawItems),
  };
  remoteSearchCache.set(query, { at: now, data });
  return data;
}

/* ---------------- 安装/移除依赖（官方 dsh plugin 语义：在 profile 目录跑 pnpm） ---------------- */

const PROFILE_MANIFEST = join(PROFILE_DIR, "package.json");
const PROFILE_WORKSPACE = join(PROFILE_DIR, "pnpm-workspace.yaml");

/** 允许的安装规格：npm 包名 或 owner/repo（GitHub），可带 github: 前缀。 */
const INSTALL_SPEC_RE =
  /^(?:github:)?[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$|^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function isSafeSpec(spec) {
  if (typeof spec !== "string" || spec.length === 0 || spec.length > 200) return false;
  if (/[\s;|&`$"'\\]|\.\./.test(spec)) return false;
  if (/^(file:|link:|git\+|https?:|ssh:)/.test(spec)) return false;
  return INSTALL_SPEC_RE.test(spec);
}

function readProfileManifestRaw() {
  try {
    return JSON.parse(readFileSync(PROFILE_MANIFEST, "utf8"));
  } catch {
    return null;
  }
}

function profileDeps(manifest) {
  return manifest && typeof manifest.dependencies === "object" ? manifest.dependencies : {};
}

function writeProfileManifestRaw(manifest) {
  writeFileSync(PROFILE_MANIFEST + ".tmp", JSON.stringify(manifest, null, 2) + "\n");
  renameSync(PROFILE_MANIFEST + ".tmp", PROFILE_MANIFEST);
}

/** 与官方 reconcile 一致：声明 dsh.bundle 的依赖加入 dsh.profile.bundles 层。 */
function reconcileBundles(addedNames) {
  const manifest = readProfileManifestRaw();
  if (!manifest) return [];
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  const joined = [];
  for (const name of addedNames) {
    const dir = installedPkgDir(name);
    let isBundle = false;
    if (dir) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        isBundle = typeof pkg.dsh?.bundle?.patch === "string";
      } catch {
        // 不可读则视为非 bundle
      }
    }
    if (isBundle && !bundles.includes(name)) {
      bundles.push(name);
      joined.push(name);
    }
  }
  if (joined.length > 0) {
    manifest.dsh = manifest.dsh ?? {};
    manifest.dsh.profile = manifest.dsh.profile ?? {};
    manifest.dsh.profile.bundles = bundles;
    writeProfileManifestRaw(manifest);
  }
  return joined;
}

/** 在已安装目录里找包（web/node_modules 优先，profiles/node_modules 兜底）。 */
function installedPkgDir(packageName) {
  for (const base of [join(PROFILE_DIR, "node_modules"), PROFILE_NM]) {
    const dir = join(base, packageName);
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  return null;
}

/**
 * 等待「指定 entryId」的 loader 条目进入终态（active=2 / failed=3）。
 * 必须按 entryId 精确匹配：同一模块名可能同时存在于宿主行、预设行等多个条目，
 * 按模块名匹配会误判（如预设行早已 active）。
 */
const FIBER_ACTIVE = 2;
const FIBER_FAILED = 3;

async function waitForEntryState(ctx, entryId, timeoutMs) {
  const start = Date.now();
  for (;;) {
    for (const entry of ctx.loader.entries()) {
      if (entry.id !== entryId || entry.fiber === void 0) continue;
      const state = entry.fiber.state;
      if (state === FIBER_ACTIVE) return "active";
      if (state === FIBER_FAILED) return "failed";
    }
    if (Date.now() - start >= timeoutMs) return "timeout";
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** 回滚一次失败/超时的安装：移除补丁行 + pnpm remove。 */
async function rollbackInstall(packageName) {
  const patch = profilePatch();
  if (!_patchParseFailed) {
    patch.rows = patch.rows.filter((row) => {
      if (!row || typeof row !== "object") return true;
      if (!Array.isArray(row.insert)) return row.id !== packageName;
      row.insert = row.insert.filter((item) => !(item && typeof item === "object" && item.id === packageName));
      return row.insert.length > 0;
    });
    writePatchFile(patch.rows);
    patch.insertIds.delete(packageName);
  }
  await pnpmRemove(packageName);
}

/**
 * pnpm add 被超时/信号终止时的半成品清理：pnpm 可能已把依赖写进 package.json
 * 但没装完（node_modules 不完整）。还原依赖到安装前，并移除 pnpm 在本地的
 * node_modules/lock（web/node_modules 只承载 profile 依赖，可重建）。
 */
async function restoreDepsAfterKill(beforeDeps) {
  const manifest = readProfileManifestRaw();
  if (manifest) {
    manifest.dependencies = { ...beforeDeps };
    writeProfileManifestRaw(manifest);
  }
  try {
    rmSync(join(PROFILE_DIR, "node_modules"), { recursive: true, force: true });
  } catch {
    // 忽略
  }
  try {
    rmSync(join(PROFILE_DIR, "pnpm-lock.yaml"), { force: true });
  } catch {
    // 忽略
  }
}

/**
 * 在 profile 目录运行 pnpm（官方 dsh plugin 的默认动作）。
 * pnpm 不在 PATH 时回退 corepack pnpm；都没有则报错。
 * 注意：pnpm v10 把错误输出写到 stdout；超时被杀的进程输出会停留在最后一行进度，
 * 因此这里合并双流 + 加大超时 + 显式标注被终止。
 */
async function runPnpm(args, timeoutMs = 300_000) {
  const candidates = [["pnpm", args], ["corepack", ["pnpm", ...args]]];
  for (const [bin, binArgs] of candidates) {
    try {
      const { stdout, stderr } = await execFileP(bin, binArgs, {
        cwd: PROFILE_DIR,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
      });
      return { ok: true, output: (stderr || stdout || "").trim() };
    } catch (e) {
      if (e.code === "ENOENT") continue; // 该 bin 不存在，试下一个
      const combined = [e.stderr, e.stdout, e.message].filter(Boolean).join("\n").trim();
      // 注意：正常非零退出时 e.signal 为 null（不是 undefined），只有被信号终止才是字符串
      const killed = e.killed === true || (typeof e.signal === "string" && e.signal !== "") || e.code === "ETIMEDOUT";
      const prefix = killed ? "[安装超时/被终止] " : "";
      return { ok: false, output: prefix + combined.slice(-2000), code: e.code, killed };
    }
  }
  return {
    ok: false,
    output: "未找到 pnpm（也不在 corepack 中）。请先安装 pnpm：npm i -g pnpm",
    code: "ENOENT",
  };
}

/**
 * 从 pnpm 的 ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED 输出里解析需要加入
 * allowBuilds 的包键（pnpm 错误信息末尾会给示例，如 `pkg@https://...: true`）。
 */
function parseAllowBuildsKey(output) {
  if (!/ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED/.test(output)) return null;
  // pnpm 提示块：allowBuilds:\n  <key>: true —— 键可能含 URL 冒号，整行截取到行尾的 ": true"
  const m = output.match(/allowBuilds:\s*\n\s*([^\n]+?):\s*true\s*\n/);
  if (m?.[1]) return m[1].trim();
  const m2 = output.match(/allowBuilds:\s*\n\s*([^\n]+?):\s*true\s*$/m);
  return m2?.[1]?.trim() ?? null;
}

/** 把包键写入 ~/.dsh/profiles/web/pnpm-workspace.yaml 的 allowBuilds（不存在则新建该节）。 */
function addAllowBuilds(key) {
  let doc = {};
  try {
    const text = readFileSync(PROFILE_WORKSPACE, "utf8");
    const parsed = parse(text);
    if (parsed && typeof parsed === "object") doc = parsed;
  } catch {
    // 文件缺失或不可解析：用空文档重建（仅追加 allowBuilds，不丢已有内容时尽量保留）
  }
  doc.allowBuilds = doc.allowBuilds && typeof doc.allowBuilds === "object" ? doc.allowBuilds : {};
  doc.allowBuilds[key] = true;
  writeFileSync(PROFILE_WORKSPACE + ".tmp", stringify(doc, { indent: 2, lineWidth: 0 }));
  renameSync(PROFILE_WORKSPACE + ".tmp", PROFILE_WORKSPACE);
  return true;
}

/** 注册一个插件行到用户补丁层（id/name = 包名），HMR 会即时挂载。 */
function persistPluginInsert(packageName) {
  const patch = profilePatch();
  if (_patchParseFailed) {
    throw new Error("无法解析 cordis.patch.yml，请手动添加补丁行");
  }
  let exists = false;
  for (const row of patch.rows) {
    if (!row || typeof row !== "object" || !Array.isArray(row.insert)) continue;
    for (const item of row.insert) {
      if (item && typeof item === "object" && item.id === packageName) exists = true;
    }
  }
  if (!exists) {
    patch.rows.push({ insert: [{ id: packageName, name: packageName }] });
    writePatchFile(patch.rows);
    patch.insertIds.add(packageName);
  }
}

/** 从 profile package.json 移除依赖（pnpm remove）。 */
async function pnpmRemove(packageName) {
  return runPnpm(["remove", packageName]);
}

/* ---------------- 插件入口 ---------------- */

export function apply(ctx) {
  const guard = (req) => {
    if (req.method !== "GET" && req.method !== "POST") return false;
    return isLoopbackRequest(req);
  };

  const pluginsHandler = async (req, res) => {
    if (!guard(req)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      json(res, 200, buildList(ctx));
    } catch (e) {
      json(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  };

  const toggleHandler = async (req, res) => {
    if (req.method !== "POST" || !isLoopbackRequest(req)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = await readBody(req);
      const entryId = String(body?.entryId ?? "");
      if (!SAFE_NAME.test(entryId)) {
        json(res, 400, { ok: false, error: "非法 entryId" });
        return;
      }
      let entry = null;
      for (const e of ctx.loader.entries()) {
        if (e.id === entryId) {
          entry = e;
          break;
        }
      }
      if (!entry) {
        json(res, 404, { ok: false, error: "未找到插件条目 " + entryId });
        return;
      }
      const cls = classify(entryId, entry.options?.name ?? "");
      if (!cls.manageable) {
        json(res, 409, { ok: false, error: "不可切换：" + (cls.manageHint ?? "该条目由运行时管理") });
        return;
      }
      const newEnabled = entry.disabled; // 翻转：启用→停用，停用→启用（entry.disabled 为 true 表示当前停用）
      persistToggle(cls.leaf, newEnabled, cls.local);
      json(res, 200, {
        ok: true,
        entryId,
        enabled: newEnabled,
        note: newEnabled ? "已启用，热重载生效中" : "已停用，热重载生效中",
      });
    } catch (e) {
      json(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  };

  const deleteHandler = async (req, res) => {
    if (req.method !== "POST" || !isLoopbackRequest(req)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = await readBody(req);
      const entryId = String(body?.entryId ?? "");
      if (!SAFE_NAME.test(entryId)) {
        json(res, 400, { ok: false, error: "非法 entryId" });
        return;
      }
      let entry = null;
      let depOnly = null;
      if (entryId.startsWith("dep:")) {
        // 已安装但未挂载的依赖条目
        depOnly = entryId.slice(4);
        if (!SAFE_NAME.test(depOnly)) {
          json(res, 400, { ok: false, error: "非法依赖名" });
          return;
        }
      } else {
        for (const e of ctx.loader.entries()) {
          if (e.id === entryId) {
            entry = e;
            break;
          }
        }
      }
      if (!entry && depOnly === null) {
        json(res, 404, { ok: false, error: "未找到插件条目 " + entryId });
        return;
      }
      const moduleName = depOnly !== null ? depOnly : entry.options?.name ?? "";
      if (depOnly !== null) {
        const deps = profileDeps(readProfileManifestRaw());
        if (!(moduleName in deps)) {
          json(res, 404, { ok: false, error: "该依赖不在 profile 依赖中：" + moduleName });
          return;
        }
        const removed = await removeLocalArtifacts(moduleName, installedPkgDir(moduleName));
        json(res, 200, { ok: true, entryId, moduleName, removed });
        return;
      }
      const cls = classify(entryId, moduleName);
      if (!cls.local) {
        json(res, 403, { ok: false, error: "官方必需插件不可删除（仅本地自定义插件可删）" });
        return;
      }
      if (moduleName === SELF_MODULE) {
        json(res, 409, { ok: false, error: "不能删除当前正在运行的管理器" });
        return;
      }
      persistDelete(cls.leaf);
      const removed = await removeLocalArtifacts(moduleName, cls.pkgDir);
      json(res, 200, { ok: true, entryId, moduleName, removed });
    } catch (e) {
      json(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  };

  const installHandler = async (req, res) => {
    if (req.method !== "POST" || !isLoopbackRequest(req)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = await readBody(req);
      const spec = String(body?.spec ?? "").trim();
      if (!isSafeSpec(spec)) {
        json(res, 400, { ok: false, error: "非法的安装规格（仅允许 npm 包名或 owner/repo）" });
        return;
      }
      // 官方 dsh plugin --profile web add <spec> 的默认动作：在 profile 目录跑 pnpm add
      const before = profileDeps(readProfileManifestRaw());
      const details = [];
      // pnpm add：遇 allowBuilds 拦截时自动写入白名单并重试（最多 2 次）
      let result = await runPnpm(["add", spec]);
      if (!result.ok && /ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED/.test(result.output || "")) {
        const buildKey = parseAllowBuildsKey(result.output);
        if (buildKey) {
          addAllowBuilds(buildKey);
          details.push(`已把 ${buildKey} 加入 pnpm allowBuilds（构建脚本白名单），自动重试…`);
          result = await runPnpm(["add", spec]);
        }
      }
      if (!result.ok) {
        const isGitHubSpec = /^(github:|[A-Za-z0-9_.-]+\/)/.test(spec);
        const out = result.output || "";
        const killed = result.killed === true;
        // 被终止时可能留下半成品（依赖已写入 package.json 但没装完）→ 还原并清理
        if (killed) {
          await restoreDepsAfterKill(before);
        }
        // 识别 GitHub 网络问题（连接超时/拒绝/重置/域名解析失败等）与安装超时
        const netIssue = /UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|getaddrinfo|fetch failed|connect timeout/i.test(out) || /timeout/i.test(out);
        let kind;
        let hint;
        if (killed) {
          kind = "install-timeout";
          hint = "安装超时（pnpm 超过 5 分钟未完成，可能是 GitHub 拉取或构建过慢）。\n建议：① 稍后网络稳定时重试；② 该插件若发布了 npm 包，改用 npm 包名安装；③ 去仓库 README 看推荐的安装方式。";
        } else if (isGitHubSpec && netIssue) {
          kind = "github-network";
          hint = "GitHub 连接超时/失败（当前网络访问 github.com 不稳定）。\n建议：① 稍后重试；② 该插件若发布了 npm 包，可改用 npm 包名安装；③ 或直接去仓库 README 查看推荐安装方式。";
        } else if (isGitHubSpec) {
          kind = "github-other";
          hint = "该 GitHub 仓库安装失败（可能不是可安装的 npm 包，或需要构建脚本）。请查看该仓库 README 的安装说明。";
        } else {
          kind = "npm-other";
          hint = null;
        }
        // error 字段不带前缀，由客户端统一加「安装失败：」避免重复
        json(res, 500, {
          ok: false,
          error: out.slice(-800),
          kind,
          gitHint: isGitHubSpec,
          hint,
        });
        return;
      }
      const after = profileDeps(readProfileManifestRaw());
      const added = Object.keys(after).filter((k) => !(k in before));
      const bundlesJoined = reconcileBundles(added);
      for (const name of bundlesJoined) details.push(`已加入 bundle 层 ${name}（重启后生效）`);
      let mountedRow = null;
      for (const name of added) {
        if (bundlesJoined.includes(name)) continue;
        // 第一步：预验证可导入（与 loader 同源解析）。导入失败（如无 main/入口的聚合根包）→ include 整树回滚、条目不会出现，直接回滚安装
        try {
          await ctx.loader.import(name);
        } catch (e) {
          await rollbackInstall(name);
          details.push(`${name}：不是可挂载的插件（无法加载入口），已自动回滚安装`);
          continue;
        }
        // 第二步：注册补丁行挂载，等「本行」loader 终态。loader 是权威：active=装完即用，failed/超时=自动回滚
        try {
          persistPluginInsert(name);
        } catch (e) {
          await rollbackInstall(name);
          details.push(`${name}：挂载失败（${String(e?.message ?? e)}），已自动回滚安装`);
          continue;
        }
        const expectedEntryId = "include:" + name;
        const state = await waitForEntryState(ctx, expectedEntryId, 8000);
        if (state === "active") {
          mountedRow = name;
          details.push(`已挂载 ${name}，装完即用`);
        } else if (state === "failed") {
          await rollbackInstall(name);
          details.push(`${name}：不是可挂载的插件（加载后无法作为插件启动），已自动回滚安装`);
        } else {
          // 8s 未就绪：可能是宿主层不兼容（如工具类插件需在会话预设中挂载）或加载过慢，回滚避免留下卡死行
          await rollbackInstall(name);
          details.push(`${name}：挂载未在 8s 内就绪（可能不兼容当前宿主层或加载过慢），已自动回滚安装`);
        }
      }
      if (details.length === 0) details.push("依赖已安装，无新增包（可能已存在）");
      json(res, 200, { ok: true, spec, added, mountedRow, details });
    } catch (e) {
      json(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  };

  const remoteHandler = async (req, res) => {
    if (req.method !== "GET" || !isLoopbackRequest(req)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      let force = false;
      try {
        force = new URL(req.url, "http://localhost").searchParams.get("force") === "1";
      } catch {
        // 忽略
      }
      const data = await fetchRemotePlugins(ctx, force);
      json(res, 200, { ok: true, ...data });
    } catch (e) {
      // 有旧缓存时降级返回缓存，避免 GitHub 限流/断网时面板空白
      if (remoteCache.data) {
        json(res, 200, { ok: true, ...remoteCache.data, stale: true, fetchError: String(e?.message ?? e) });
        return;
      }
      json(res, 502, { ok: false, error: "远程仓库获取失败：" + String(e?.message ?? e) });
    }
  };

  const remoteSearchHandler = async (req, res) => {
    if (req.method !== "GET" || !isLoopbackRequest(req)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      let q = "";
      try {
        q = String(new URL(req.url, "http://localhost").searchParams.get("q") || "").trim();
      } catch {
        // 保持空查询
      }
      if (q.length === 0 || q.length > 100) {
        json(res, 400, { ok: false, error: "查询为空或过长（1-100 字符）" });
        return;
      }
      if (/[\u0000-\u001f"\\]/.test(q)) {
        json(res, 400, { ok: false, error: "查询含非法字符" });
        return;
      }
      const data = await searchRemotePlugins(ctx, q);
      json(res, 200, { ok: true, ...data });
    } catch (e) {
      if (e?.code === "RATE_LIMIT") {
        json(res, 429, { ok: false, error: String(e?.message ?? e) });
        return;
      }
      json(res, 502, { ok: false, error: "远程搜索失败：" + String(e?.message ?? e) });
    }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: "/dsh-plugin-manager-api/plugins", handler: pluginsHandler }),
    "dsh-plugin-manager-panel: plugins route",
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: "/dsh-plugin-manager-api/plugins/toggle", handler: toggleHandler }),
    "dsh-plugin-manager-panel: toggle route",
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: "/dsh-plugin-manager-api/plugins/delete", handler: deleteHandler }),
    "dsh-plugin-manager-panel: delete route",
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: "/dsh-plugin-manager-api/remote", handler: remoteHandler }),
    "dsh-plugin-manager-panel: remote route",
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: "/dsh-plugin-manager-api/plugins/install", handler: installHandler }),
    "dsh-plugin-manager-panel: install route",
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: "/dsh-plugin-manager-api/remote/search", handler: remoteSearchHandler }),
    "dsh-plugin-manager-panel: remote search route",
  );
}
