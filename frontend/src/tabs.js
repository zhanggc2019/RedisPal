import { Activity, Database, KeyRound, Radio, Search, Terminal } from '@lucide/vue'
import { display } from './model.js'

/** Select the icon that identifies a workspace tab's content. */
export function tabIcon(kind) {
  switch (kind) {
    case 'home': return Database
    case 'key':
    case 'new': return KeyRound
    case 'cli': return Terminal
    case 'pubsub': return Radio
    case 'search': return Search
    default: return Activity
  }
}

/** Format a tab caption from its connection, database, or raw key. */
export function tabName(tab, connections, tr) {
  const name = connections.find(item => item.id === tab.connection)?.name || ''
  switch (tab.kind) {
    case 'home': return tr('工作台', 'Workspace')
    case 'server': return name
    case 'key': return display(tab.key) || '␀'
    case 'new': return tr('新建 Key', 'New key')
    case 'cli': return 'CLI · ' + name
    case 'pubsub': return 'Pub/Sub'
    case 'search': return 'Redis Search'
    case 'profiler': return tr('实时监控', 'Profiler')
    case 'slow': return tr('慢日志', 'Slow log')
    case 'memory': return tr('内存分析', 'Memory analysis')
    case 'logs': return tr('命令日志', 'Command log')
    default: return tab.kind
  }
}

/** Resolve a tab key to the next roving-tabindex position. */
export function nextTabIndex(current, length, key) {
  if (length <= 0) return -1
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown': return (current + 1) % length
    case 'ArrowLeft':
    case 'ArrowUp': return (current - 1 + length) % length
    case 'Home': return 0
    case 'End': return length - 1
    default: return current
  }
}
