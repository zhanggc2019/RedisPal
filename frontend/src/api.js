import { Application, Browser, Call, Clipboard, Dialogs, Events, Window } from '@wailsio/runtime'
import { asArg } from './model.js'

// call invokes a named method on the Go Redis service.
export function call(method, ...args) {
  return Call.ByName('redismanager/internal/redisdesk.Service.' + method, ...args)
}

// updateCall invokes the application-level release service.
export function updateCall(method, ...args) {
  return Call.ByName('main.ReleaseUpdates.' + method, ...args)
}

// desktopCall invokes window lifecycle actions on the native application.
export function desktopCall(method, ...args) {
  return Call.ByName('main.DesktopWindow.' + method, ...args)
}

// command sends a complete RESP command with binary-safe arguments.
export async function command(id, db, ...args) {
  const reply = await call('Command', id, db, args.map(asArg))
  return reply.value
}

// selectFile opens the native file chooser for a certificate or private key path.
export function selectFile(title) {
  return Dialogs.OpenFile({ Title: title, CanChooseFiles: true, AllowsMultipleSelection: false })
}

export { Application, Browser, Clipboard, Events, Window }
