# dsh-plugin-manager — DSH 插件管理器

DSH Web 客户端插件目录，包含一个 DSH Web 客户端插件 `dsh-plugin-manager-panel`，
在 Web 侧边栏底部新增「插件管理」入口，解决宿主端插件清单"杂乱、无介绍、不知道为何启停"的问题。

## 功能

- **全量插件清单**：列出当前运行实例的全部 Loader 插件条目（与宿主端插件清单同源），
  每个条目带：功能描述（中文）、启用状态、来源层、版本、分类。
- **两个分区**：
  - **本地自定义插件**：你自己在 `~/.dsh/profiles/web/cordis.patch.yml` 里插入的插件
    （或本地源码目录中的插件）—— 可删除。
  - **官方插件**：dsh-base / dsh-web-app bundle、agent 预设、运行时动态行 —— 必需，不可删除。
- **启用/停用开关**：可管理的条目显示开关。修改写入用户补丁层
  （`cordis.patch.yml`），被 DSH 的 HMR 监听，**热重载即时生效，无需重启**，重启后依然生效。
- **删除按钮**：仅本地自定义插件可删。npm 安装的插件执行 `pnpm remove` 卸载依赖与文件；
  本地源码插件删除补丁行 + node_modules 软链 + 源码目录。
- **必装标记**：核心插件标「核心必装」并禁止停用；停用条目显示「停用原因」
  （如 Web 层按设计停用、平台不适用、预设未安装等）。
- **远程插件 tab**：展示 GitHub `topic:dsh-plugin` 仓库列表（★ 排序、疑似 DSH 插件绿标），
  每个仓库带「安装」按钮——执行**官方默认动作** `dsh plugin --profile web add <pkg>`
  （等价于在 profile 目录运行 `pnpm add`，pnpm 不在 PATH 时回退 `corepack pnpm`），
  声明了 `dsh.bundle` 的包加入 bundle 层（重启生效），
  声明了 `dsh` 字段的包自动注册补丁行（HMR 即时挂载）。

## 目录结构

```
dsh-plugin-manager/
└── dsh-plugin-manager-panel/
    ├── package.json        # name: dsh-plugin-manager-panel, dsh.client.platform: web
    └── lib/
        ├── index.js        # 宿主半部：/dsh-plugin-manager-api/{plugins,toggle,delete} 路由
        └── client.js       # 浏览器半部：sidebar.footer.action 槽位面板
```

## 安装
### 自动装：仓库链接扔给DSH，让它自动装
### 手动装：（以软链方式挂载到 web profile）

1. 软链到 web profile 的 node_modules：

   ```bash
   ln -sfn "<你的插件源码目录>/dsh-plugin-manager-panel" \
     "$HOME/.dsh/profiles/node_modules/dsh-plugin-manager-panel"
   ```

2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 增加一行（HMR 会自动挂载，无需重启）：

   ```yaml
   - insert:
       - id: dsh-plugin-manager-panel
         name: dsh-plugin-manager-panel
   ```

3. 刷新浏览器页面，侧边栏底部出现「插件管理」按钮。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/dsh-plugin-manager-api/plugins` | 全量清单（描述/状态/来源/必装/停用原因） |
| POST | `/dsh-plugin-manager-api/plugins/toggle` | `{entryId}` 启用/停用（写补丁层，HMR 生效） |
| POST | `/dsh-plugin-manager-api/plugins/delete` | `{entryId}` 删除本地自定义插件 |

## 注意事项

- 停用/删除写入 `~/.dsh/profiles/web/cordis.patch.yml`（用户补丁层），不要手改 `cordis.yml`
  （该文件每次启动会被重置）。
- 本地源码目录中的插件也可被识别为「本地自定义插件」（可删除），需通过环境变量
  `DSH_LOCAL_PLUGIN_DIRS` 指定（多个目录用 `:` 分隔），如 `DSH_LOCAL_PLUGIN_DIRS=/path/to/my-plugins`。
- 会话预设行（`include:agent-presets:*`）由 agent 预设管理，面板上只读展示、不可切换。
- 面板自身不可停用/删除。
