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
      colService: '服务',
      colTransport: '传输',
      colTools: '工具',
      colTokens: 'tokens',
      colCost: '占用',
      colStatus: '状态',
      colLazy: '懒启动',
      colEnabled: '启用',
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
      loading: '读取中…',
      retry: '重试',
      empty: '没有符合条件的服务。',
      share: '占全局工具',
      ofTools: '个工具',
      lazySaving: '可省',
      lazyServers: '台懒启动',
      lazySaved: '懒启动设置已保存，插件重载后生效',
      lazyFailed: '懒启动设置失败',
      enabledSaved: '已保存',
      unknownError: '读取失败',
      toggleFailed: '切换失败',
      restartNeeded: '已保存，需重启 dsh web 才能完全生效',
    };

    const en = {
      title: 'MCP services',
      running: 'Running',
      stopped: 'Stopped',
      colService: 'Service',
      colTransport: 'Transport',
      colTools: 'Tools',
      colTokens: 'tokens',
      colCost: 'Cost',
      colStatus: 'Status',
      colLazy: 'Lazy',
      colEnabled: 'On',
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
      loading: 'Loading…',
      retry: 'Retry',
      empty: 'No service matches this filter.',
      share: 'of all tool schemas',
      ofTools: 'tools',
      lazySaving: 'saves',
      lazyServers: 'lazy',
      lazySaved: 'Lazy setting saved; takes effect once the plugin reloads',
      lazyFailed: 'Lazy toggle failed',
      enabledSaved: 'Saved',
      unknownError: 'Request failed',
      toggleFailed: 'Toggle failed',
      restartNeeded: 'Saved; restart dsh web to fully apply',
    };

    const CSS = [
      '.mm-root{font-size:13px;color:var(--dsw-alias-label-primary);container-type:inline-size;}',
      '.mm-title{font-size:15px;font-weight:600;margin:0 0 12px;color:var(--dsw-alias-label-primary);}',
      '.mm-summary{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:10px 14px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;}',
      '.mm-sum{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap;}',
      '.mm-sum b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums;}',
      '.mm-dot{width:6px;height:6px;border-radius:50%;flex:none;}',
      '.mm-dot-on{background:var(--dsw-alias-state-success-primary);}',
      '.mm-dot-off{background:var(--dsw-alias-state-idle-primary);}',
      '.mm-sep{width:1px;height:13px;background:var(--dsw-alias-border-l2);}',
      '.mm-spacer{flex:1;}',
      '.mm-seg{display:flex;gap:2px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:2px;}',
      '.mm-seg button{font:inherit;font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:transparent;border:0;border-radius:6px;padding:3px 10px;display:flex;align-items:center;gap:5px;}',
      '.mm-seg button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
      '.mm-seg .mm-count{font-size:10.5px;opacity:.7;font-variant-numeric:tabular-nums;}',
      '.mm-table{margin-top:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;}',
      // 设置面板的内容列宽度有限，九列排不下会把服务名挤成竖排并压到相邻列上：
      // 传输并入服务名次行；「占用」条在面板窄于 620px 时整列隐藏（tokens 数字仍保留）。
      // 服务名是唯一的弹性列，有下限 minmax(140px,1fr)，其余列按内容定宽。
      '.mm-head,.mm-row{display:grid;grid-template-columns:16px minmax(140px,1fr) 46px 60px 56px 66px 50px 38px;align-items:center;gap:10px;padding:0 14px;}',
      '@container (max-width:620px){.mm-head,.mm-row{grid-template-columns:16px minmax(130px,1fr) 46px 58px 62px 48px 36px;gap:8px;padding:0 12px;}.mm-cost{display:none;}}',
      '.mm-head{height:34px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:10.5px;letter-spacing:.05em;opacity:.8;white-space:nowrap;}',
      '.mm-head .mm-r{text-align:right;}',
      '.mm-head .mm-c{text-align:center;}',
      '.mm-row{min-height:50px;cursor:pointer;border-top:1px solid var(--dsw-alias-border-l1);transition:background .12s ease;}',
      '.mm-row:first-child{border-top:0;}',
      '.mm-row:hover,.mm-row-open{background:var(--dsw-alias-bg-layer-2);}',
      '.mm-caret{display:grid;place-items:center;color:var(--dsw-alias-label-secondary);opacity:.7;}',
      '.mm-name-cell{display:flex;align-items:center;gap:10px;min-width:0;overflow:hidden;}',
      '.mm-badge{width:26px;height:26px;border-radius:7px;flex:none;display:grid;place-items:center;font-size:9.5px;font-weight:700;background:var(--dsw-alias-bg-layer-2);color:var(--mm-c);border:1px solid var(--dsw-alias-border-l1);}',
      '.mm-name-block{min-width:0;flex:1 1 auto;overflow:hidden;}',
      '.mm-name{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.mm-name>span{overflow:hidden;text-overflow:ellipsis;}',
      '.mm-sub{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.85;}',
      '.mm-chip{font-size:10px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);white-space:nowrap;font-family:ui-monospace,"Cascadia Code",Consolas,monospace;}',
      '.mm-chip-lazy{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}',
      '.mm-num{text-align:right;font-size:12.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.mm-num-strong{color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.mm-num-dim{opacity:.55;}',
      '.mm-track{height:6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;}',
      '.mm-fill{height:100%;border-radius:4px;background:var(--mm-c);opacity:.85;}',
      '.mm-track-none{height:6px;border-radius:4px;border:1px dashed var(--dsw-alias-border-l2);}',
      '.mm-status{display:flex;align-items:center;gap:6px;font-size:11.5px;white-space:nowrap;overflow:hidden;color:var(--dsw-alias-label-secondary);}',
      '.mm-status-on{color:var(--dsw-alias-state-success-primary);}',
      '.mm-status i{width:6px;height:6px;border-radius:50%;background:currentColor;}',
      '.mm-switch{position:relative;width:32px;height:19px;border-radius:999px;background:var(--dsw-alias-state-idle-primary);border:0;cursor:pointer;padding:0;justify-self:center;align-self:center;transition:background .18s ease;}',
      '.mm-switch::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:transform .18s ease;box-shadow:0 1px 3px rgba(0,0,0,.4);}',
      '.mm-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);}',
      '.mm-switch[aria-checked="true"]::after{transform:translateX(13px);}',
      '.mm-switch[disabled]{opacity:.5;cursor:default;}',
      '.mm-expand{padding:0 14px 14px 40px;background:var(--dsw-alias-bg-layer-2);}',
      '.mm-expand-inner{border-top:1px dashed var(--dsw-alias-border-l2);padding-top:11px;}',
      '.mm-expand-cap{display:flex;align-items:center;gap:8px;margin-bottom:8px;color:var(--dsw-alias-label-secondary);font-size:10.5px;letter-spacing:.04em;opacity:.85;}',
      '.mm-tool-grid{display:flex;flex-wrap:wrap;gap:5px;}',
      '.mm-tool{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:2px 7px;}',
      '.mm-note{margin-top:9px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.65;opacity:.85;}',
      // 用途说明编辑器：展开区里的一块，宽度随面板容器自适应。
      '.mm-note-edit{margin-top:12px;padding-top:11px;border-top:1px dashed var(--dsw-alias-border-l2);}',
      '.mm-note-head{display:flex;align-items:baseline;gap:8px;margin-bottom:6px;color:var(--dsw-alias-label-secondary);font-size:10.5px;letter-spacing:.04em;opacity:.9;}',
      '.mm-note-tip{font-size:10.5px;line-height:1.6;opacity:.75;letter-spacing:0;margin:0 0 7px;}',
      '.mm-note-input{display:block;width:100%;box-sizing:border-box;resize:vertical;min-height:58px;font:inherit;font-size:11.5px;line-height:1.65;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);outline:none;}',
      '.mm-note-input:focus{border-color:var(--dsw-alias-brand-primary);}',
      '.mm-note-actions{display:flex;align-items:center;gap:8px;margin-top:7px;}',
      '.mm-btn{font:inherit;font-size:11.5px;line-height:1.5;padding:4px 12px;border-radius:6px;cursor:pointer;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);}',
      '.mm-btn:hover{border-color:var(--dsw-alias-border-l2);}',
      // 主按钮用 label/bg 反色，不依赖 brand-primary：部分主题里它是白色，白底白字会看不见。
      '.mm-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);border-color:transparent;font-weight:600;}',
      '.mm-btn-primary:hover{background:var(--dsw-alias-label-primary);border-color:transparent;opacity:.88;}',
      '.mm-btn[disabled]{opacity:.4;cursor:default;}',
      '.mm-btn[disabled]:hover{border-color:var(--dsw-alias-border-l1);}',
      '.mm-note-count{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.7;font-variant-numeric:tabular-nums;}',
      '.mm-chip-note{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}',
      '.mm-empty{color:var(--dsw-alias-label-secondary);font-size:11.5px;opacity:.8;}',
      '.mm-empty-row{display:block;padding:16px 14px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11.5px;}',
      '.mm-banner{margin-top:12px;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;}',
      '.mm-banner-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.mm-retry{font:inherit;font-size:11.5px;padding:3px 10px;border-radius:6px;cursor:pointer;background:transparent;color:inherit;border:1px solid currentColor;}',
      '.mm-skel{height:74px;border-radius:12px;margin-top:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);}',
    ].join('');

    const fmt = (n) => Number(n).toLocaleString('en-US');
    const initials = (id) => id.replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase() || '??';

    /** Keep in sync with MAX_NOTE in index.js. */
    const NOTE_MAX = 600;

    const caretSvg = (open) => h('svg', {
      width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round',
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

    function Row({ row, color, open, busy, tr, onToggle, onToggleLazy, onOpen, onSaveNote }) {
      const tokens = row.tokens > 0 ? fmt(row.tokens) : '—';
      const tools = row.tools.length > 0 ? String(row.tools.length) : '—';
      const maxTokens = Math.max(row.__maxTokens || 1, 1);
      const width = row.tokens > 0 ? Math.max(3, Math.round((row.tokens / maxTokens) * 100)) : 0;

      const head = h('div', {
        className: 'mm-row' + (open ? ' mm-row-open' : ''),
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
        h('span', { className: 'mm-caret' }, caretSvg(open)),
        h('div', { className: 'mm-name-cell' },
          h('div', { className: 'mm-badge', style: { '--mm-c': color } }, initials(row.serverName)),
          h('div', { className: 'mm-name-block' },
            h('div', { className: 'mm-name', title: row.serverName },
              h('span', null, row.serverName),
              row.lazy ? h('span', { className: 'mm-chip mm-chip-lazy' }, 'lazy') : null,
              // A written purpose is worth knowing about from the collapsed row:
              // the glyph says one exists, hovering reads it.
              row.note ? h('span', { className: 'mm-chip mm-chip-note', title: row.note }, tr('noteTag')) : null,
            ),
            // 传输并进次行：设置面板只有 ~600px 宽，单独开一列会把服务名挤成竖排。
            h('div', { className: 'mm-sub', title: row.id + ' · ' + row.transport },
              row.id + ' · ' + row.transport),
          ),
        ),
        h('div', { className: 'mm-num' + (row.tools.length ? '' : ' mm-num-dim') }, tools),
        h('div', { className: 'mm-num' + (row.tokens > 0 ? ' mm-num-strong' : ' mm-num-dim') }, tokens),
        h('div', { className: 'mm-cost' }, row.tokens > 0
          ? h('div', { className: 'mm-track' }, h('div', { className: 'mm-fill', style: { width: width + '%', '--mm-c': color } }))
          : h('div', { className: 'mm-track-none' })),
        h('div', null, h('span', { className: 'mm-status' + (row.enabled ? ' mm-status-on' : '') },
          h('i', null), row.enabled ? tr('running') : tr('stopped'))),
        h(Switch, {
          checked: !!row.lazy,
          disabled: busy,
          label: row.serverName + ' ' + tr('colLazy'),
          title: tr('colLazy'),
          onChange: onToggleLazy,
        }),
        h(Switch, {
          checked: row.enabled,
          disabled: busy,
          label: row.serverName + ' ' + tr('colEnabled'),
          title: tr('colEnabled'),
          onChange: onToggle,
        }),
      );

      const panel = open ? h('div', { className: 'mm-expand' },
        h('div', { className: 'mm-expand-inner' },
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
        ),
      ) : null;

      return h(React.Fragment, { key: row.id }, head, panel);
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

      if (loading && !state) {
        return h(React.Fragment, null,
          h('style', null, CSS),
          h('div', { className: 'mm-root' }, h('div', { className: 'mm-skel' })),
        );
      }

      if (error && !state) {
        return h(React.Fragment, null,
          h('style', null, CSS),
          h('div', { className: 'mm-root' },
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
          h('div', { className: 'mm-title' }, tr('title')),

          h('div', { className: 'mm-summary' },
            h('div', { className: 'mm-sum' }, h('span', { className: 'mm-dot mm-dot-on' }), h('b', null, String(totals.enabled)), ' ', tr('running')),
            h('div', { className: 'mm-sum' }, h('span', { className: 'mm-dot mm-dot-off' }), h('b', null, String(totals.rows - totals.enabled)), ' ', tr('stopped')),
            h('span', { className: 'mm-sep' }),
            h('div', { className: 'mm-sum' }, h('b', null, String(totals.tools)), ' ', tr('ofTools')),
            h('span', { className: 'mm-sep' }),
            h('div', { className: 'mm-sum' },
              h('b', null, fmt(totals.tokens)), ' tokens',
              totals.share > 0 ? h('span', { style: { opacity: 0.8 } }, ' · ' + tr('share') + ' ' + totals.share + '%') : null,
            ),
            totals.lazy > 0 ? h('div', { className: 'mm-sum' },
              h('span', { className: 'mm-sep' }),
              h('b', null, String(totals.lazy)), ' ', tr('lazyServers'),
              h('span', { style: { opacity: 0.8 } }, ' · ' + tr('lazySaving') + ' ' + fmt(totals.lazyTokens) + ' tokens'),
            ) : null,
            h('span', { className: 'mm-spacer' }),
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

          h('div', { className: 'mm-table' },
            h('div', { className: 'mm-head' },
              h('span', null),
              h('span', null, tr('colService')),
              h('span', { className: 'mm-r' }, tr('colTools')),
              h('span', { className: 'mm-r' }, tr('colTokens')),
              h('span', { className: 'mm-r mm-cost' }, tr('colCost')),
              h('span', null, tr('colStatus')),
              h('span', { className: 'mm-c' }, tr('colLazy')),
              h('span', { className: 'mm-c' }, tr('colEnabled')),
            ),
            shown.length === 0
              ? h('div', { className: 'mm-empty-row' }, tr('empty'))
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
