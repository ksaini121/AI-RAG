import { useRef, useState } from 'react'
import { ACCEPT_ATTR, ALLOWED_EXTENSIONS, MAX_UPLOAD_BYTES } from './constants'

export function Dropzone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  const take = (list: FileList | null) => {
    if (list && list.length > 0) onFiles(Array.from(list))
  }

  return (
    <div
      className={`rounded-lg border-2 border-dashed p-8 text-center ${
        over ? 'border-slate-900 bg-slate-100' : 'border-slate-300 bg-white'
      }`}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        take(e.dataTransfer.files)
      }}
    >
      <p className="text-slate-700">Drag files here, or</p>
      <button
        type="button"
        className="mt-2 rounded bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-700"
        onClick={() => input.current?.click()}
      >
        Choose files
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT_ATTR}
        className="hidden"
        onChange={(e) => {
          take(e.target.files)
          e.target.value = ''
        }}
      />
      <p className="mt-2 text-xs text-slate-500">
        {ALLOWED_EXTENSIONS.join(' ')} · up to {MAX_UPLOAD_BYTES / (1024 * 1024)} MB
      </p>
    </div>
  )
}
