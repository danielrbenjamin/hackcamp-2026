import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'

const views = {
  cloud: '3D scan', grid: 'Occupancy grid', depth: 'Depth & confidence',
  combined: 'Combined overlay', separate: 'Individual models', scan: '3D scan overlay',
} as const
export type EditorView = keyof typeof views
const extraViews = new Set<EditorView>(['grid', 'depth', 'combined'])
type Group = { tabs: EditorView[]; active: EditorView }
type Edge = 'left' | 'right' | 'top' | 'bottom'
type Layout = { groups: Group[]; axis: 'horizontal' | 'vertical' }
const edges: Edge[] = ['left', 'right', 'top', 'bottom']
const mime = 'application/x-lantern-view'

export function EditorWorkspace({ layout, setLayout, renderView }: {
  layout: Layout
  setLayout: (layout: Layout) => void
  renderView: (view: EditorView) => ReactNode
}) {
  const [dragged, setDragged] = useState<EditorView>()
  const [target, setTarget] = useState<Edge | number>()
  const [ratio, setRatio] = useState(50)
  const [openedExtras, setOpenedExtras] = useState<EditorView[]>([])
  const [expandedPane, setExpandedPane] = useState<number>()
  const workspace = useRef<HTMLDivElement>(null)
  const { groups, axis } = layout
  const split = groups.length === 2

  useEffect(() => {
    if (expandedPane === undefined) return
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') setExpandedPane(undefined)
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [expandedPane])

  function finishDrag() {
    setDragged(undefined)
    setTarget(undefined)
  }

  function splitView(view: EditorView, edge: Edge) {
    const remaining = groups[0].tabs.filter(tab => tab !== view && !extraViews.has(tab))
    if (!remaining.length) return
    const other = { tabs: remaining, active: remaining.includes(groups[0].active) ? groups[0].active : remaining[0] }
    const next = { tabs: [view, ...groups[0].tabs.filter(tab => tab !== view && extraViews.has(tab))], active: view }
    setRatio(50)
    setLayout({
      groups: edge === 'left' || edge === 'top' ? [next, other] : [other, next],
      axis: edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical',
    })
  }

  function moveView(view: EditorView, index: number) {
    if (groups[index].tabs.includes(view)) return
    setLayout({ ...layout, groups: groups.map((group, position) => {
      if (position === index) return { tabs: [...group.tabs, view], active: view }
      const tabs = group.tabs.filter(tab => tab !== view)
      return { tabs, active: group.active === view ? tabs[0] : group.active }
    }).filter(group => group.tabs.length) })
  }

  function selectView(view: EditorView, index: number) {
    const openingExtra = extraViews.has(view) && !openedExtras.includes(view)
    if (openingExtra) setOpenedExtras(current => [...current, view])
    setLayout({ ...layout, groups: groups.map((pane, position) =>
      position === index ? {
        tabs: openingExtra ? [...pane.tabs.filter(tab => tab !== view), view] : pane.tabs,
        active: view,
      } : pane) })
  }

  function closeExtra(view: EditorView, index: number) {
    setOpenedExtras(current => current.filter(tab => tab !== view))
    const group = groups[index]
    if (group.active !== view) return
    const next = group.tabs.find(tab => tab !== view && (!extraViews.has(tab) || openedExtras.includes(tab)))
    if (next) {
      selectView(next, index)
    } else if (split) {
      const other = groups[1 - index]
      setLayout({ ...layout, groups: [{ tabs: [...other.tabs, ...group.tabs], active: other.active }] })
    }
  }

  function accept(event: DragEvent, destination: Edge | number) {
    if (!dragged) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setTarget(destination)
  }

  function drop(event: DragEvent, destination: Edge | number) {
    if (!dragged || event.dataTransfer.getData(mime) !== dragged) return
    event.preventDefault()
    if (typeof destination === 'number') moveView(dragged, destination)
    else splitView(dragged, destination)
    finishDrag()
  }

  const resize = (value: number) => setRatio(Math.min(75, Math.max(25, value)))

  return <div className="editor-workspace" data-axis={axis} ref={workspace}
    style={split ? axis === 'horizontal'
      ? { gridTemplateColumns: `minmax(0, ${ratio}fr) 7px minmax(0, ${100 - ratio}fr)` }
      : { gridTemplateRows: `minmax(0, ${ratio}fr) 7px minmax(0, ${100 - ratio}fr)` } : undefined}>
    {groups.map((group, index) => <section key={index} className="editor-group" data-expanded={expandedPane === index}
      aria-label={`Editor pane ${index + 1}`}>
      <div className="editor-strip" data-drop={split && target === index}
        onDragOver={split ? event => accept(event, index) : undefined}
        onDrop={split ? event => drop(event, index) : undefined}>
        {expandedPane === index ? <h2 className="expanded-view-title">{views[group.active]}</h2> : <>
        <div className="editor-tabs" role="group" aria-label="Views">
          {group.tabs.filter(view => !extraViews.has(view) || openedExtras.includes(view) || group.active === view)
            .map(view => <div className="editor-tab" key={view}><button draggable data-dragging={dragged === view}
            aria-pressed={group.active === view} onClick={() => selectView(view, index)}
            onDragStart={event => {
              event.dataTransfer.setData(mime, view)
              event.dataTransfer.effectAllowed = 'move'
              setDragged(view)
            }} onDragEnd={finishDrag}>{views[view]}</button>
              {extraViews.has(view) && <button className="editor-tab-close" aria-label={`Close ${views[view]}`}
                title={`Close ${views[view]}`} onClick={() => closeExtra(view, index)}>×</button>}
            </div>)}
        </div>
        {group.tabs.some(view => extraViews.has(view) && !openedExtras.includes(view) && group.active !== view) &&
        <select className="editor-extra-views" aria-label="More views"
          value="" onChange={event => selectView(event.target.value as EditorView, index)}>
          <option value="" disabled>More</option>
          {group.tabs.filter(view => extraViews.has(view) && !openedExtras.includes(view) && group.active !== view)
            .map(view => <option key={view} value={view}>{views[view]}</option>)}
        </select>}
        </>}
        <div className="editor-actions">
          {(expandedPane === index || group.active === 'cloud' || group.active === 'scan' || group.active === 'depth') &&
            <button title={expandedPane === index ? 'Exit full screen (Esc)' : 'Full screen'}
              aria-label={expandedPane === index ? 'Exit full screen' : 'Full screen'}
              onClick={() => setExpandedPane(expandedPane === index ? undefined : index)}>
              {expandedPane === index ? '×' : '⛶'}
            </button>}
          {expandedPane === index ? null : split ? <button title="Merge editor panes" aria-label={`Merge editor pane ${index + 1}`}
            onClick={() => setLayout({ ...layout, groups: [{ tabs: groups.flatMap(pane => pane.tabs), active: groups[1 - index].active }] })}>×</button>
            : <>
              <button title="Split right" aria-label="Split right" onClick={() => splitView(group.active, 'right')}>◫</button>
              <button title="Split down" aria-label="Split down" onClick={() => splitView(group.active, 'bottom')}>⬒</button>
            </>}
        </div>
      </div>
      <div className="viewport" key={group.active}>{renderView(group.active)}</div>
      {!split && dragged && <div className="editor-dropzones">
        {edges.map(edge => <div key={edge} data-edge={edge} data-drop={target === edge}
          onDragOver={event => accept(event, edge)} onDragLeave={() => setTarget(undefined)}
          onDrop={event => drop(event, edge)}>Split {edge}</div>)}
      </div>}
    </section>)}
    {split && <div className="editor-divider" tabIndex={0} role="separator" aria-label="Resize editor panes"
      aria-orientation={axis === 'horizontal' ? 'vertical' : 'horizontal'} aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(ratio)}
      onKeyDown={event => {
        const keys = axis === 'horizontal' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
        if (!keys.includes(event.key)) return
        event.preventDefault()
        resize(ratio + (event.key === keys[0] ? -5 : 5))
      }}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        const bounds = workspace.current?.getBoundingClientRect()
        if (!bounds) return
        resize(axis === 'horizontal' ? 100 * (event.clientX - bounds.left) / bounds.width
          : 100 * (event.clientY - bounds.top) / bounds.height)
      }} />}
  </div>
}

export const initialLayout: Layout = { groups: [{ tabs: ['cloud', 'grid', 'depth', 'combined', 'separate', 'scan'], active: 'cloud' }], axis: 'horizontal' }
