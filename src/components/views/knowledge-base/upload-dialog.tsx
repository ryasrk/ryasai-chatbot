'use client'

import { useRef, useState } from 'react'
import {
  UploadCloud,
  X,
  AlertTriangle,
  Loader2,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { cn } from '@/lib/utils'
import { extractError } from '@/lib/extract-error'
import { ACCEPTED, MAX_BYTES, formatSize, fileIconFor } from './helpers'

export function UploadDialog({
  open,
  onOpenChange,
  onUploaded,
  existingCategories,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onUploaded: () => void
  existingCategories: string[]
}) {
  const [file, setFile] = useState<File | null>(null)
  const [category, setCategory] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [sizeError, setSizeError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setFile(null)
    setCategory('')
    setDescription('')
    setSizeError(null)
    setDragOver(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  const pickFile = (f: File | null | undefined) => {
    if (!f) return
    if (f.size > MAX_BYTES) {
      setSizeError(
        `File size ${formatSize(f.size)} exceeds the 50 MB limit (spec §8).`,
      )
      setFile(null)
      return
    }
    if (f.size <= 0) {
      setSizeError('File is empty.')
      setFile(null)
      return
    }
    setSizeError(null)
    setFile(f)
  }

  const handleSubmit = async () => {
    if (!file) {
      toast.error('Please select a file first.')
      return
    }
    if (sizeError) {
      toast.error(sizeError)
      return
    }
    setSubmitting(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('category', category.trim() || 'Uncategorized')
      fd.append('description', description)
      const res = await fetch('/api/documents', { method: 'POST', body: fd })
      const json = await res.json()
      if (res.ok && json.document) {
        toast.success('Document uploaded & processed.')
        reset()
        onUploaded()
      } else if (res.status === 413) {
        setSizeError(
          `File exceeds 50 MB (spec §8). Size: ${formatSize(
            json.sizeBytes ?? file.size,
          )}.`,
        )
      } else {
        toast.error(extractError(json.error, 'Failed to upload document.'))
      }
    } catch (e) {
      toast.error('Network error while uploading.')
      console.error(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!submitting) {
          onOpenChange(o)
          if (!o) reset()
        }
      }}
    >
      <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload Document</DialogTitle>
          <DialogDescription>
            Supports PDF, DOCX, XLSX, TXT, MD. Max 50 MB. Files are automatically
            chunked for RAG retrieval.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Drag & drop area */}
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              pickFile(e.dataTransfer.files?.[0])
            }}
            onClick={() => inputRef.current?.click()}
            className={cn(
              'cursor-pointer rounded-lg border-2 border-dashed p-6 text-center transition-colors',
              dragOver
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-primary/50 hover:bg-muted/40',
            )}
          >
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED}
              className="sr-only"
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
            {file ? (
              <div className="flex items-center justify-center gap-2">
                {(() => {
                  const { Icon, className: cls } = fileIconFor(
                    file.name.split('.').pop() ?? '',
                  )
                  return (
                    <div
                      className={cn(
                        'h-9 w-9 rounded-md flex items-center justify-center',
                        cls,
                      )}
                    >
                      <Icon className="h-4.5 w-4.5" />
                    </div>
                  )
                })()}
                <div className="text-left min-w-0">
                  <div className="text-sm font-medium truncate max-w-[280px]">
                    {file.name}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatSize(file.size)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setFile(null)
                    if (inputRef.current) inputRef.current.value = ''
                  }}
                  className="ml-1 p-1 rounded hover:bg-muted"
                  aria-label="Remove file selection"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <>
                <UploadCloud className="h-8 w-8 mx-auto text-muted-foreground/60 mb-2" />
                <p className="text-sm font-medium">
                  Drag a file here or click to select
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  PDF, DOCX, XLSX, TXT, MD · max 50 MB
                </p>
              </>
            )}
          </div>

          {sizeError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{sizeError}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="doc-cat">Category</Label>
            <Input
              id="doc-cat"
              list="category-suggestions"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Type or select a category (e.g. SOP, Finance, HR)"
              className="text-xs"
            />
            <datalist id="category-suggestions">
              {existingCategories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <p className="text-[10px] text-muted-foreground">
              Custom category — type anything. Existing categories appear as suggestions.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="doc-desc">Description (optional)</Label>
            <Textarea
              id="doc-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Brief summary of the document content…"
              className="resize-none"
            />
          </div>
        </div>

          {submitting && file && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Uploading {file.name}...
            </div>
          )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !file}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Processing &amp; chunking…
              </>
            ) : (
              <>
                <UploadCloud className="h-4 w-4" />
                Upload
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
