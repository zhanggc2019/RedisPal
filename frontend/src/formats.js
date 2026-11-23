import { Buffer } from 'buffer'
import JSONBigFactory from '@qii404/json-bigint'
import { asArg, display, toBytes } from './model.js'

const JSONBig = JSONBigFactory({ useNativeBigInt: true })
export const formats = ['Text', 'JSON', 'Hex', 'Binary', 'Msgpack', 'PHPSerialize', 'JavaSerialize', 'Pickle', 'Brotli', 'Gzip', 'Deflate', 'DeflateRaw', 'Protobuf', 'Custom']
export const writableFormats = ['Text', 'JSON', 'Hex', 'Binary']

// pretty keeps large integers, binary data and collection types legible in a text editor.
export function pretty(value) {
  return JSONBig.stringify(value, (_key, item) => {
    if (item instanceof Map) return Object.fromEntries(item)
    if (item instanceof Set) return [...item]
    if (item instanceof Uint8Array) return { hex: Buffer.from(item).toString('hex') }
    return item
  }, 2)
}

// guessFormat detects JSON strings and bytes that cannot be displayed as UTF-8.
export function guessFormat(value) {
  if (value && typeof value === 'object' && 'hex' in value) return 'Hex'
  if (typeof value === 'string' && /^[\s]*[{[]/.test(value)) {
    try {
      JSONBig.parse(value)
      return 'JSON'
    } catch { /* Keep non-JSON strings in the text editor. */ }
  }
  return 'Text'
}

// encodeEdited converts the visible editable format into a Redis argument.
export function encodeEdited(mode, text) {
  if (mode === 'JSON') {
    JSONBig.parse(text)
    return text
  }
  if (mode === 'Hex') {
    const hex = text.replace(/\s+/g, '').replace(/^0x/i, '')
    if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error('Invalid hexadecimal value')
    return { hex }
  }
  if (mode === 'Binary') {
    const data = text.replace(/\s+/g, '')
    if (!/^(?:[01]{8})*$/.test(data)) throw new Error('Binary values require groups of eight bits')
    const bytes = data.match(/.{8}/g) || []
    return { hex: Buffer.from(bytes.map(byte => Number.parseInt(byte, 2))).toString('hex') }
  }
  return text
}

// decodeProto uses descriptors to read a schema without compiling JavaScript at runtime.
function decodeProto(pb, type, reader, end, depth = 0) {
  if (depth > 80) throw new Error('Protobuf message is nested too deeply')
  const data = Object.create(null)
  type.resolveAll()
  /** Decode one scalar, enum, or nested protobuf value. */
  function read(field, wire) {
    if (field.resolvedType instanceof pb.Type) {
      const length = reader.uint32()
      return decodeProto(pb, field.resolvedType, reader, reader.pos + length, depth + 1)
    }
    if (field.resolvedType instanceof pb.Enum) {
      const id = reader.int32()
      return field.resolvedType.valuesById[id] ?? id
    }
    if (typeof reader[field.type] !== 'function') return reader.skipType(wire)
    const value = reader[field.type]()
    return value && typeof value === 'object' && !(value instanceof Uint8Array) ? value.toString() : value
  }
  while (reader.pos < end) {
    const tag = reader.uint32()
    const wire = tag & 7
    const field = type.fieldsById[tag >>> 3]
    if (!field) {
      reader.skipType(wire)
      continue
    }
    if (field.map) {
      const length = reader.uint32()
      const limit = reader.pos + length
      let key = ''
      let value = null
      while (reader.pos < limit) {
        const inner = reader.uint32()
        if (inner >>> 3 === 1) key = String(reader[field.keyType]())
        else if (inner >>> 3 === 2) value = read(field, inner & 7)
        else reader.skipType(inner & 7)
      }
      ;(data[field.name] ??= Object.create(null))[key] = value
    } else if (field.repeated) {
      const target = (data[field.name] ??= [])
      if (wire === 2 && !(field.resolvedType instanceof pb.Type) && !['bytes', 'string'].includes(field.type)) {
        const length = reader.uint32()
        const limit = reader.pos + length
        while (reader.pos < limit) target.push(read(field, wire))
      } else target.push(read(field, wire))
    } else data[field.name] = read(field, wire)
  }
  return data
}

// decodeProtoFields exposes field numbers and exact bytes when no schema is available.
function decodeProtoFields(pb, bytes) {
  const reader = pb.Reader.create(bytes)
  const fields = {}
  const decoder = new TextDecoder('utf-8', { fatal: true })
  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    const id = tag >>> 3
    if (!id) throw new Error('Invalid protobuf field number')
    let value
    switch (tag & 7) {
      case 0: value = reader.uint64().toString(); break
      case 1: value = reader.fixed64().toString(); break
      case 2: {
        const bytes = reader.bytes()
        value = { hex: Buffer.from(bytes).toString('hex') }
        try {
          const string = decoder.decode(bytes)
          if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(string)) value = string
        } catch { /* Keep the hex representation for non-UTF-8 fields. */ }
        break
      }
      case 5: value = reader.fixed32(); break
      default: reader.skipType(tag & 7); continue
    }
    ;(fields[id] ??= []).push(value)
  }
  return fields
}

// renderFormat decodes value bytes locally, or delegates bounded decompression to Go.
export async function renderFormat(mode, value, schema, custom, invoke) {
  if (value == null) return ''
  const bytes = toBytes(value)
  switch (mode) {
    case 'Text': return typeof value === 'object' ? new TextDecoder().decode(bytes) : display(value)
    case 'JSON': {
      const text = typeof value === 'string' ? value : new TextDecoder().decode(bytes)
      try {
        return pretty(JSONBig.parse(text))
      } catch {
        return text
      }
    }
    case 'Hex': return Buffer.from(bytes).toString('hex').match(/.{2}/g)?.join(' ') || ''
    case 'Binary': return Array.from(bytes, byte => byte.toString(2).padStart(8, '0')).join(' ')
    case 'Msgpack': return pretty((await import('@msgpack/msgpack')).decode(bytes, { useBigInt64: true }))
    case 'PHPSerialize': return pretty((await import('php-serialize')).unserialize(Buffer.from(bytes), {}, { strict: false }))
    case 'JavaSerialize': return pretty(new (await import('java-object-serialization')).ObjectInputStream(bytes).readObject())
    case 'Pickle': return pretty(new (await import('pickleparser')).Parser().parse(bytes))
    case 'Gzip': case 'Brotli': case 'Deflate': case 'DeflateRaw': {
      return display(await invoke('Decode', mode, asArg(value)))
    }
    case 'Protobuf': {
      const module = await import('protobufjs')
      const pb = module.default || module
      if (!schema?.type || !schema.sources?.length) return pretty(decodeProtoFields(pb, bytes))
      const root = new pb.Root()
      for (const source of schema.sources) pb.parse(source, root, { keepCase: true })
      return pretty(decodeProto(pb, root.lookupType(schema.type), pb.Reader.create(bytes), bytes.length))
    }
    case 'Custom': {
      if (!custom?.executable) return ''
      return display(await invoke('FormatWith', custom.executable, custom.args, asArg(value)))
    }
    default: return display(value)
  }
}
