/**
 * Client half of the MCP manage bundle: the「MCP管理」page in the settings panel.
 *
 * It registers into the `settings.section` list slot (one settings page per
 * entry; `id` is the nav key, `order` its position, `label` the nav text) — the
 * configuration UI lives there now, not on the bundle's own Plugins page.
 *
 * Everything shown is read from the Host route (`/mcp-manage/api/state`): the
 * browser has no MCP service of its own. Two switches per row:
 *
 *   启用   整台服务器装/卸载 — the Host forwards to
 *          `pluginManager.setPluginEnabled`, which persists to the profile and
 *          rebuilds the Loader;
 *   懒启动 会话级懒启动 — the Host records the server in this bundle's own row
 *          config and keeps its tools OUT of a fresh session's tool block until
 *          the model loads them with `mcp_tools`. This is the switch that
 *          actually reduces token cost.
 *
 * Both are cheap to flip and slow to settle (a Loader rebuild, a plugin
 * reload), so each one flips the row optimistically and re-reads after a beat.
 *
 * Layout notes (learned the hard way, do not "simplify" these away):
 *   - one card per server, not a wide table: the settings content column is
 *     560–700px and eight fixed columns squeezed the service name to ~40px;
 *   - the switch captions live under the switches, so no header row is needed;
 *   - card surfaces are a translucent tint of `label-primary` on purpose:
 *     `bg-layer-1` is *darker* than the settings panel in the dark theme, which
 *     made the cards read as a different material.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mcp-manage',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect } = React;

    /** Locale namespace owned by this panel. */
    const NS = 'mcpManage';

    /** Nav identity of this page inside the settings panel. */
    const SECTION = { id: 'mcp-manage', order: 18, label: 'MCP管理' };

    /** Host route prefix (see index.js). */
    const API = '/mcp-manage/api';

    /** Accent per row; a row's identity is only cosmetic, so a palette is fine. */
    const PALETTE = ['#7b8cff', '#37d67a', '#f5a623', '#4ea8ff', '#b45cff', '#37c0d6', '#e5695f', '#d6a337'];

    const zh = {
      title: 'MCP 服务',
      running: '运行中',
      stopped: '已停用',
      ofTools: '个工具',
      colLazy: '懒启动',
      colEnabled: '启用',
      lazyTag: '懒启动',
      noteTitle: '用途说明',
      noteTag: '说明',
      noteHint: '可选。填好后，懒启动时会把服务名和这段说明一起交给模型，它才知道什么时候该装载这台服务。留空就只给名字。',
      notePlaceholder: '例：本地 ComfyUI 出图流水线，文生图 / 图生图 / 放大 / 批量变体；需要画图或改图时装载。',
      noteSave: '保存说明',
      noteClear: '清除',
      noteSaved: '用途说明已保存',
      noteFailed: '用途说明保存失败',
      toolList: '工具清单',
      notLoaded: '未加载',
      notLoadedHint: '该服务已停用，启用并重连后在此列出它注册的工具。',
      lazyToolsHint: '已配置会话级懒启动：这些工具默认不进入请求，模型调用 mcp_tools 装载后才出现在当前会话。',
      filterAll: '全部',
      filterOn: '运行中',
      filterOff: '已停用',
      filterLazy: '懒启动',
      retry: '重试',
      empty: '没有符合条件的服务。',
      share: '占全局工具',
      lazySaving: '可省',
      lazyServers: '台懒启动',
      lazySaved: '懒启动设置已保存，插件重载后生效',
      lazyFailed: '懒启动设置失败',
      unknownError: '读取失败',
      toggleFailed: '切换失败',
      restartNeeded: '已保存，需重启 dsh web 才能完全生效',
    };

    const en = {
      running: 'Running',
      stopped: 'Stopped',
      ofTools: 'tools',
      colLazy: 'Lazy',
      colEnabled: 'On',
      lazyTag: 'lazy',
      noteTitle: 'Purpose',
      noteTag: 'note',
      noteHint: 'Optional. When this server is lazy, its name and this description are handed to the model, so it can tell which server a task needs. Leave it empty to send the name alone.',
      notePlaceholder: 'e.g. Local ComfyUI pipeline — text-to-image, editing, upscaling, batch variants; load it for any image task.',
      noteSave: 'Save',
      noteClear: 'Clear',
      noteSaved: 'Description saved',
      noteFailed: 'Saving the description failed',
      toolList: 'Tools',
      notLoaded: 'not loaded',
      notLoadedHint: 'This server is stopped. Enable it and reconnect to list the tools it registers.',
      lazyToolsHint: 'Session-lazy is on: these tools stay out of the request until the model loads them into the current session with mcp_tools.',
      filterAll: 'All',
      filterOn: 'Running',
      filterOff: 'Stopped',
      filterLazy: 'Lazy',
      retry: 'Retry',
      empty: 'No service matches this filter.',
      share: 'of all tool schemas',
      lazySaving: 'saves',
      lazyServers: 'lazy',
      lazySaved: 'Lazy setting saved; takes effect once the plugin reloads',
      lazyFailed: 'Lazy toggle failed',
      unknownError: 'Request failed',
      toggleFailed: 'Toggle failed',
      restartNeeded: 'Saved; restart dsh web to fully apply',
    };

    /**
     * Surfaces are a tint of the primary label rather than a named layer token:
     * it lands in the same colour family as whatever the panel paints behind it,
     * in both themes. `--mm-tint-*` keep the three levels readable at the call
     * site instead of repeating color-mix maths.
     */
    const CSS = [
      '.mm-root{font-size:13px;color:var(--dsw-alias-label-primary);--mm-tint-4:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);--mm-tint-7:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);--mm-tint-11:color-mix(in srgb,var(--dsw-alias-label-primary) 11%,transparent);--mm-hair:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);container-type:inline-size;}',

      // ── 顶部：标题 + 一行统计 + 右侧筛选，窄容器自动折行 ────────────
      // 设置壳只把 section 的 label 用在左侧导航，正文标题由 section 自己画
      // （官方「内置插件」页也是这个套路：heading 18px/600）。
      '.mm-heading{margin:0 0 10px;font-size:18px;font-weight:600;line-height:1.35;letter-spacing:.01em;}',
      '.mm-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 14px;}',
      '.mm-stats{display:flex;align-items:center;gap:11px;flex-wrap:wrap;min-width:0;}',
      '.mm-stat{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap;}',
      '.mm-stat b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums;}',
      '.mm-dot{width:6px;height:6px;border-radius:50%;flex:none;background:currentColor;}',
      '.mm-dot-on{color:var(--dsw-alias-state-success-primary);}',
      '.mm-dot-off{color:var(--dsw-alias-state-idle-primary);}',
      '.mm-sep{width:1px;height:12px;flex:none;background:var(--mm-hair);}',
      '.mm-seg{display:flex;gap:2px;margin-left:auto;padding:2px;border-radius:9px;background:var(--mm-tint-7);}',
      '.mm-seg button{font:inherit;font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:transparent;border:0;border-radius:7px;padding:3px 10px;display:flex;align-items:center;gap:5px;transition:background .12s ease,color .12s ease;}',
      '.mm-seg button:hover{color:var(--dsw-alias-label-primary);}',
      '.mm-seg button[aria-pressed="true"]{background:var(--mm-tint-11);color:var(--dsw-alias-label-primary);}',
      '.mm-seg .mm-count{font-size:10.5px;opacity:.65;font-variant-numeric:tabular-nums;}',

      // ── 服务器卡片列表 ─────────────────────────────────────────────
      '.mm-list{display:flex;flex-direction:column;gap:9px;}',
      '.mm-card{border-radius:13px;background:var(--mm-tint-4);border:1px solid var(--mm-hair);overflow:hidden;transition:background .13s ease,border-color .13s ease;}',
      '.mm-card:hover{background:var(--mm-tint-7);}',
      '.mm-card-open{background:var(--mm-tint-7);}',
      '.mm-main{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:16px;min-height:66px;padding:10px 15px;cursor:pointer;}',
      '.mm-ident{display:flex;align-items:center;gap:11px;min-width:0;}',
      '.mm-caret{width:13px;flex:none;display:grid;place-items:center;color:var(--dsw-alias-label-secondary);opacity:.6;}',
      '.mm-badge{width:29px;height:29px;border-radius:9px;flex:none;display:grid;place-items:center;font-size:10px;font-weight:700;letter-spacing:.02em;color:var(--mm-c);background:color-mix(in srgb,var(--mm-c) 15%,transparent);border:1px solid color-mix(in srgb,var(--mm-c) 32%,transparent);}',
      '.mm-ident-text{min-width:0;flex:1 1 auto;}',
      '.mm-name{display:flex;align-items:center;gap:6px;min-width:0;font-size:13.5px;font-weight:600;line-height:1.35;}',
      '.mm-name-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.mm-card-off .mm-name-text{color:var(--dsw-alias-label-secondary);font-weight:500;}',
      '.mm-sub{display:flex;align-items:center;gap:6px;min-width:0;margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:11px;}',
      '.mm-sub-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;}',
      '.mm-chip{flex:none;font-size:10px;line-height:1.6;padding:0 7px;border-radius:999px;color:var(--dsw-alias-label-secondary);border:1px solid var(--mm-tint-11);white-space:nowrap;font-family:ui-monospace,"Cascadia Code",Consolas,monospace;}',
      '.mm-chip-note{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);}',

      '.mm-metric{display:flex;flex-direction:column;align-items:flex-end;gap:6px;min-width:128px;}',
      '.mm-metric-line{display:flex;align-items:baseline;gap:5px;white-space:nowrap;font-variant-numeric:tabular-nums;}',
      '.mm-tokens{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.mm-tokens-none{font-weight:500;color:var(--dsw-alias-label-secondary);opacity:.6;}',
      '.mm-tools{font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.mm-bar{width:100%;height:3px;border-radius:2px;background:var(--mm-tint-11);overflow:hidden;}',
      '.mm-bar-fill{height:100%;border-radius:2px;background:var(--mm-c);opacity:.9;}',

      '.mm-ctrls{display:flex;align-items:center;gap:15px;}',
      '.mm-ctrl{display:flex;flex-direction:column;align-items:center;gap:4px;}',
      '.mm-ctrl-label{font-size:10px;line-height:1.2;color:var(--dsw-alias-label-secondary);letter-spacing:.02em;white-space:nowrap;}',
      '.mm-switch{position:relative;width:34px;height:20px;border-radius:999px;background:var(--mm-tint-11);border:0;padding:0;cursor:pointer;transition:background .18s ease;}',
      '.mm-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .18s ease;box-shadow:0 1px 3px rgba(0,0,0,.35);}',
      '.mm-switch[aria-checked="true"]{background:var(--dsw-alias-state-success-primary);}',
      '.mm-switch[aria-checked="true"]::after{transform:translateX(14px);}',
      '.mm-switch[disabled]{opacity:.45;cursor:default;}',

      // ── 展开区：工具清单 + 用途说明 ────────────────────────────────
      '.mm-expand{padding:11px 15px 14px 39px;border-top:1px solid var(--mm-hair);}',
      '.mm-expand-cap{display:flex;align-items:center;gap:8px;margin-bottom:8px;color:var(--dsw-alias-label-secondary);font-size:10.5px;letter-spacing:.04em;}',
      '.mm-tool-grid{display:flex;flex-wrap:wrap;gap:5px;}',
      '.mm-tool{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:10px;padding:2px 7px;border-radius:5px;color:var(--dsw-alias-label-secondary);background:var(--mm-tint-7);}',
      '.mm-empty{color:var(--dsw-alias-label-secondary);font-size:11.5px;opacity:.85;}',
      '.mm-note{margin-top:10px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.65;opacity:.85;}',
      '.mm-note-edit{margin-top:12px;padding-top:11px;border-top:1px dashed var(--mm-hair);}',
      '.mm-note-head{display:flex;align-items:baseline;gap:8px;margin-bottom:6px;color:var(--dsw-alias-label-secondary);font-size:10.5px;letter-spacing:.04em;}',
      '.mm-note-tip{font-size:10.5px;line-height:1.6;opacity:.8;letter-spacing:0;margin:0 0 8px;}',
      '.mm-note-input{display:block;width:100%;box-sizing:border-box;resize:vertical;min-height:58px;font:inherit;font-size:11.5px;line-height:1.65;padding:8px 10px;border-radius:9px;border:1px solid var(--mm-hair);background:var(--mm-tint-4);color:var(--dsw-alias-label-primary);outline:none;}',
      '.mm-note-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.7;}',
      '.mm-note-input:focus{border-color:var(--dsw-alias-brand-primary);}',
      '.mm-note-actions{display:flex;align-items:center;gap:8px;margin-top:8px;}',
      '.mm-btn{font:inherit;font-size:11.5px;line-height:1.5;padding:4px 12px;border-radius:7px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-primary);border:1px solid var(--mm-tint-11);}',
      '.mm-btn:hover{background:var(--mm-tint-7);}',
      // 主按钮用 label/bg 反色，不依赖 brand-primary：部分主题里它是白色，白底白字会看不见。
      '.mm-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);border-color:transparent;font-weight:600;}',
      '.mm-btn-primary:hover{background:var(--dsw-alias-label-primary);opacity:.88;}',
      '.mm-btn[disabled]{opacity:.4;cursor:default;}',
      '.mm-btn[disabled]:hover{background:transparent;}',
      '.mm-btn-primary[disabled]:hover{background:var(--dsw-alias-label-primary);}',
      '.mm-note-count{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.7;font-variant-numeric:tabular-nums;}',

      // ── 状态条 ─────────────────────────────────────────────────────
      '.mm-empty-card{padding:22px 15px;border-radius:13px;border:1px dashed var(--mm-hair);color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center;}',
      '.mm-banner{display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:9px 13px;border-radius:10px;border:1px solid var(--mm-hair);background:var(--mm-tint-4);color:var(--dsw-alias-label-secondary);font-size:12px;}',
      '.mm-banner-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.mm-retry{font:inherit;font-size:11.5px;padding:3px 10px;border-radius:6px;cursor:pointer;background:transparent;color:inherit;border:1px solid currentColor;}',
      '.mm-skel{height:66px;border-radius:13px;background:var(--mm-tint-4);border:1px solid var(--mm-hair);margin-bottom:9px;}',

      // 窄容器：去掉占用条，收窄数字列与开关间距（tokens 数字始终保留）。
      '@container (max-width:600px){.mm-bar{display:none;}.mm-metric{min-width:92px;gap:0;}.mm-ctrls{gap:11px;}.mm-main{gap:12px;padding:10px 12px;}.mm-expand{padding-left:36px;}}',
      '@container (max-width:470px){.mm-metric{display:none;}}',
    ].join('');

    const fmt = (n) => Number(n).toLocaleString('en-US');
    const initials = (id) => id.replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase() || '??';

    /** Keep in sync with MAX_NOTE in index.js. */
    const NOTE_MAX = 600;

    const caretSvg = (open) => h('svg', {
      width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round',
    }, h('path', { d: open ? 'm6 9 6 6 6-6' : 'm9 18 6-6-6-6' }));

    function Switch({ checked, disabled, label, title, onChange }) {
      return h('button', {
        type: 'button',
        className: 'mm-switch',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        title,
        disabled: disabled || undefined,
        onClick: (event) => {
          event.stopPropagation();
          if (!disabled) onChange();
        },
      });
    }

    /**
     * The per-server purpose editor (expanded row).
     *
     * The draft lives here instead of in the panel so typing re-renders one row
     * and so a `/state` re-read cannot overwrite what is being typed.
     */
    function NoteEditor({ row, tr, busy, onSave }) {
      const saved = row.note || '';
      const [draft, setDraft] = useState(saved);
      // A re-read (another tab, another row saved) replaces the baseline, but
      // only when the text really differs from what is on screen.
      useEffect(() => {
        setDraft((current) => (current.trim() === saved.trim() ? current : saved));
      }, [saved, row.id]);
      const changed = draft.trim() !== saved.trim();
      return h('div', {
        className: 'mm-note-edit',
        onClick: (event) => event.stopPropagation(),
        onKeyDown: (event) => event.stopPropagation(),
      },
        h('div', { className: 'mm-note-head' }, h('span', null, tr('noteTitle'))),
        h('div', { className: 'mm-note-tip' }, tr('noteHint')),
        h('textarea', {
          className: 'mm-note-input',
          value: draft,
          rows: 3,
          maxLength: NOTE_MAX,
          spellCheck: false,
          placeholder: tr('notePlaceholder'),
          'aria-label': row.serverName + ' ' + tr('noteTitle'),
          onChange: (event) => setDraft(event.target.value),
        }),
        h('div', { className: 'mm-note-actions' },
          h('button', {
            type: 'button',
            className: 'mm-btn mm-btn-primary',
            disabled: busy || !changed,
            onClick: () => onSave(draft.trim()),
          }, tr('noteSave')),
          saved.length > 0
            ? h('button', {
                type: 'button',
                className: 'mm-btn',
                disabled: busy,
                onClick: () => onSave(''),
              }, tr('noteClear'))
            : null,
          h('span', { className: 'mm-note-count' }, draft.length + '/' + NOTE_MAX),
        ),
      );
    }

    /** One switch with its caption underneath — the caption replaces a table header. */
    function Control({ checked, disabled, label, caption, onChange }) {
      return h('div', { className: 'mm-ctrl' },
        h(Switch, { checked, disabled, label, title: label, onChange }),
        h('span', { className: 'mm-ctrl-label' }, caption),
      );
    }

    function Row({ row, color, open, busy, tr, onToggle, onToggleLazy, onOpen, onSaveNote }) {
      const tokens = row.tokens > 0 ? fmt(row.tokens) : '—';
      const toolsLine = row.tools.length > 0 ? row.tools.length + ' ' + tr('ofTools') : tr('notLoaded');
      const maxTokens = Math.max(row.__maxTokens || 1, 1);
      const width = row.tokens > 0 ? Math.max(3, Math.round((row.tokens / maxTokens) * 100)) : 0;

      const head = h('div', {
        className: 'mm-main',
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open ? 'true' : 'false',
        onClick: onOpen,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen();
          }
        },
      },
        h('div', { className: 'mm-ident' },
          h('span', { className: 'mm-caret' }, caretSvg(open)),
          h('div', { className: 'mm-badge', style: { '--mm-c': color } }, initials(row.serverName)),
          h('div', { className: 'mm-ident-text' },
            h('div', { className: 'mm-name', title: row.serverName },
              h('span', { className: 'mm-name-text' }, row.serverName),
            ),
            // 传输并进次行，和状态点、徽标一起；服务名独占一行才不会被挤成竖排。
            h('div', { className: 'mm-sub' },
              h('span', { className: 'mm-dot ' + (row.enabled ? 'mm-dot-on' : 'mm-dot-off') }),
              h('span', { className: 'mm-sub-text', title: row.id + ' · ' + row.transport },
                row.id + ' · ' + row.transport),
              row.lazy ? h('span', { className: 'mm-chip', title: tr('colLazy') }, tr('lazyTag')) : null,
              // A written purpose is worth knowing about from the collapsed row:
              // the chip says one exists, hovering reads it.
              row.note ? h('span', { className: 'mm-chip mm-chip-note', title: row.note }, tr('noteTag')) : null,
            ),
          ),
        ),

        h('div', { className: 'mm-metric' },
          h('div', { className: 'mm-metric-line' },
            h('span', { className: 'mm-tokens' + (row.tokens > 0 ? '' : ' mm-tokens-none') }, tokens),
            h('span', { className: 'mm-tools' }, ' tokens · ' + toolsLine),
          ),
          h('div', { className: 'mm-bar' }, h('div', {
            className: 'mm-bar-fill',
            style: { width: width + '%', '--mm-c': color },
          })),
        ),

        h('div', { className: 'mm-ctrls' },
          h(Control, {
            checked: !!row.lazy,
            disabled: busy,
            label: row.serverName + ' ' + tr('colLazy'),
            caption: tr('colLazy'),
            onChange: onToggleLazy,
          }),
          h(Control, {
            checked: !!row.enabled,
            disabled: busy,
            label: row.serverName + ' ' + tr('colEnabled'),
            caption: tr('colEnabled'),
            onChange: onToggle,
          }),
        ),
      );

      const panel = open ? h('div', { className: 'mm-expand' },
        h('div', { className: 'mm-expand-cap' },
          h('span', null, tr('toolList')),
          h('span', null, row.tools.length ? row.tools.length + ' ' + tr('ofTools') : tr('notLoaded')),
        ),
        row.tools.length
          ? h('div', { className: 'mm-tool-grid' }, row.tools.map((tool) =>
              h('span', { key: tool.name, className: 'mm-tool', title: 'mcp__' + row.serverName + '__' + tool.name }, tool.name)))
          : h('div', { className: 'mm-empty' }, tr('notLoadedHint')),
        row.lazy && row.tools.length ? h('div', { className: 'mm-note' }, tr('lazyToolsHint')) : null,
        h(NoteEditor, { row, tr, busy, onSave: onSaveNote }),
      ) : null;

      return h(React.Fragment, { key: row.id },
        h('div', {
          className: 'mm-card'
            + (open ? ' mm-card-open' : '')
            + (row.enabled ? '' : ' mm-card-off'),
        }, head, panel),
      );
    }

    function Panel(props) {
      const tr = typeof props.t === 'function'
        ? props.t
        : (key) => (zh[key] !== undefined ? zh[key] : key);

      const [state, setState] = useState(null);
      const [error, setError] = useState('');
      const [loading, setLoading] = useState(true);
      const [filter, setFilter] = useState('all');
      const [open, setOpen] = useState({});
      const [busy, setBusy] = useState(false);
      const [nonce, setNonce] = useState(0);
      const [notice, setNotice] = useState('');

      // A locale switch while this page is open must re-render it: `t` itself
      // reads the active locale at call time, but React needs a nudge.
      const [, setTick] = useState(0);
      useEffect(() => {
        const locale = props.locale;
        if (!locale || typeof locale.subscribe !== 'function') return undefined;
        return locale.subscribe(() => setTick((value) => value + 1));
      }, [props.locale]);

      useEffect(() => {
        let alive = true;
        setLoading(true);
        fetch(API + '/state', { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((payload) => {
            if (!alive) return;
            if (payload && payload.ok) {
              setState(payload.value);
              setError('');
            } else {
              setError((payload && payload.error && payload.error.message) || tr('unknownError'));
            }
          })
          .catch((cause) => {
            if (alive) setError(String((cause && cause.message) || cause));
          })
          .finally(() => {
            if (alive) setLoading(false);
          });
        return () => { alive = false; };
      }, [nonce]);

      /** POST one mutation and re-read after the Host has had a beat to settle. */
      const mutate = (path, body, optimistic, failKey, okKey) => {
        setBusy(true);
        setNotice('');
        if (optimistic) setState((prev) => (prev && prev.rows ? optimistic(prev) : prev));
        fetch(API + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then((response) => response.json())
          .then((payload) => {
            if (!payload || !payload.ok) {
              throw new Error((payload && payload.error && payload.error.message) || tr(failKey));
            }
            const value = payload.value || {};
            if (okKey) setNotice(tr(okKey));
            if (value.application === 'restart-required') setNotice(tr('restartNeeded'));
            // A Loader rebuild or a plugin reload is asynchronous; re-reading
            // immediately would report the stale row and the switch would look
            // stuck.
            setTimeout(() => setNonce((n) => n + 1), 1200);
          })
          .catch((cause) => {
            setError(String((cause && cause.message) || cause));
            setNonce((n) => n + 1);
          })
          .finally(() => setBusy(false));
      };

      const toggleEnabled = (row) => {
        const next = !row.enabled;
        mutate('/toggle', { id: row.id, enabled: next },
          (prev) => ({ ...prev, rows: prev.rows.map((item) => (item.id === row.id ? { ...item, enabled: next } : item)) }),
          'toggleFailed',
          null);
      };

      const toggleLazy = (row) => {
        const next = !row.lazy;
        mutate('/lazy', { server: row.serverName, lazy: next },
          (prev) => ({ ...prev, rows: prev.rows.map((item) => (item.id === row.id ? { ...item, lazy: next } : item)) }),
          'lazyFailed',
          'lazySaved');
      };

      /** Persist one server's purpose; '' clears it. */
      const saveNote = (row, note) => {
        mutate('/note', { server: row.serverName, note },
          (prev) => ({ ...prev, rows: prev.rows.map((item) => (item.id === row.id ? { ...item, note } : item)) }),
          'noteFailed',
          'noteSaved');
      };

      const toggleOpen = (id) => setOpen((current) => ({ ...current, [id]: !current[id] }));

      const heading = h('h2', { className: 'mm-heading' }, tr('title'));

      if (loading && !state) {
        return h(React.Fragment, null,
          h('style', null, CSS),
          h('div', { className: 'mm-root' }, heading,
            [0, 1, 2, 3].map((key) => h('div', { key, className: 'mm-skel' }))),
        );
      }

      if (error && !state) {
        return h(React.Fragment, null,
          h('style', null, CSS),
          h('div', { className: 'mm-root' }, heading,
            h('div', { className: 'mm-banner mm-banner-error' },
              h('span', null, error),
              h('button', { type: 'button', className: 'mm-retry', onClick: () => setNonce((n) => n + 1) }, tr('retry')),
            ),
          ),
        );
      }

      const rows = state ? state.rows : [];
      const totals = (state && state.totals) || { rows: 0, enabled: 0, tools: 0, tokens: 0, share: 0, lazy: 0, lazyTokens: 0 };
      const maxTokens = rows.reduce((max, row) => Math.max(max, row.tokens || 0), 0) || 1;
      const shown = rows
        .map((row) => ({ ...row, __maxTokens: maxTokens }))
        .filter((row) => {
          if (filter === 'on') return row.enabled;
          if (filter === 'off') return !row.enabled;
          if (filter === 'lazy') return row.lazy;
          return true;
        });

      const filterButton = (key, label, count) => h('button', {
        type: 'button',
        'aria-pressed': filter === key ? 'true' : 'false',
        onClick: () => setFilter(key),
      }, label, ' ', h('span', { className: 'mm-count' }, String(count)));

      return h(React.Fragment, null,
        h('style', null, CSS),
        h('div', { className: 'mm-root' },
          heading,
          h('div', { className: 'mm-top' },
            h('div', { className: 'mm-stats' },
              h('div', { className: 'mm-stat' },
                h('span', { className: 'mm-dot mm-dot-on' }),
                h('b', null, String(totals.enabled)), ' ', tr('running')),
              h('div', { className: 'mm-stat' },
                h('span', { className: 'mm-dot mm-dot-off' }),
                h('b', null, String(totals.rows - totals.enabled)), ' ', tr('stopped')),
              h('span', { className: 'mm-sep' }),
              h('div', { className: 'mm-stat' }, h('b', null, String(totals.tools)), ' ', tr('ofTools')),
              h('span', { className: 'mm-sep' }),
              h('div', { className: 'mm-stat' },
                h('b', null, fmt(totals.tokens)), ' tokens',
                totals.share > 0 ? h('span', { style: { opacity: 0.75 } }, ' · ' + tr('share') + ' ' + totals.share + '%') : null,
              ),
              totals.lazy > 0 ? h(React.Fragment, null,
                h('span', { className: 'mm-sep' }),
                h('div', { className: 'mm-stat' },
                  h('b', null, String(totals.lazy)), ' ', tr('lazyServers'),
                  h('span', { style: { opacity: 0.75 } }, ' · ' + tr('lazySaving') + ' ' + fmt(totals.lazyTokens) + ' tokens'),
                ),
              ) : null,
            ),
            h('div', { className: 'mm-seg' },
              filterButton('all', tr('filterAll'), totals.rows),
              filterButton('on', tr('filterOn'), totals.enabled),
              filterButton('off', tr('filterOff'), totals.rows - totals.enabled),
              filterButton('lazy', tr('filterLazy'), totals.lazy || 0),
            ),
          ),

          error ? h('div', { className: 'mm-banner mm-banner-error' },
            h('span', null, error),
            h('button', { type: 'button', className: 'mm-retry', onClick: () => setNonce((n) => n + 1) }, tr('retry')),
          ) : null,

          notice ? h('div', { className: 'mm-banner' }, notice) : null,

          h('div', { className: 'mm-list' },
            shown.length === 0
              ? h('div', { className: 'mm-empty-card' }, tr('empty'))
              : shown.map((row, index) => h(Row, {
                  key: row.id,
                  row,
                  color: row.enabled ? PALETTE[index % PALETTE.length] : 'var(--dsw-alias-state-idle-primary)',
                  open: !!open[row.id],
                  busy,
                  tr,
                  onToggle: () => toggleEnabled(row),
                  onToggleLazy: () => toggleLazy(row),
                  onSaveNote: (note) => saveNote(row, note),
                  onOpen: () => toggleOpen(row.id),
                })),
          ),
        ),
      );
    }

    function apply(ctx) {
      ctx.effect(() => {
        const offZh = ctx.locale.register(NS, 'zh', zh);
        const offEn = ctx.locale.register(NS, 'en', en);
        return () => { offZh(); offEn(); };
      }, 'dsh-mcp-manage: dictionaries');

      // The translate function reads the active locale at call time, so the
      // page follows a locale switch without re-registering the section.
      const translate = () => (ctx.locale && typeof ctx.locale.bind === 'function')
        ? ctx.locale.bind(NS)
        : (key) => (zh[key] !== undefined ? zh[key] : key);

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION.id,
        order: SECTION.order,
        label: SECTION.label,
      }, (props) => h(Panel, { ...props, t: translate(), locale: ctx.locale })));
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
