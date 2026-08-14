'use client'

import { useEffect, useState } from 'react'
import { Layers, AlertCircle, Loader2, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { VECTOR_STORE_PRESETS, getVectorStorePreset } from '@/lib/db-provider-presets'
import { extractError } from '@/lib/extract-error'

export function VectorStorePanel() {
  const [provider, setProvider] = useState('INTERNAL')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [collectionName, setCollectionName] = useState('ryasai_chunks')
  const [vectorSize, setVectorSize] = useState('1536')
  const [distance, setDistance] = useState('Cosine')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [loadError, setLoadError] = useState(false)

  const vsPreset = getVectorStorePreset(provider)
  const vsBackend = vsPreset?.backend ?? provider
  const isInternal = vsBackend === 'INTERNAL'
  const needsApiKey = vsPreset?.needsApiKey ?? false

  const handleProviderChange = (id: string) => {
    const p = getVectorStorePreset(id)
    setProvider(id)
    if (p) {
      setVectorSize(String(p.defaultVectorSize))
      // A base URL belongs to exactly one provider — a Qdrant URL can never
      // serve a Milvus config. Always swap it to the new provider's default;
      // leaving the old provider's URL behind produced configs that saved and
      // then failed at test/search time with a confusing cross-provider error.
      setBaseUrl(p.baseUrlPlaceholder)
    }
  }

  useEffect(() => {
    let cancelled = false
    fetch('/api/vector-store', { cache: 'no-store' })
      .then((res) => res.json())
      .then((json) => {
        if (cancelled || !json.ok || !json.data) return
        setProvider(json.data.provider ?? 'INTERNAL')
        setBaseUrl(json.data.baseUrl ?? '')
        setCollectionName(json.data.collectionName ?? 'ryasai_chunks')
        setVectorSize(String(json.data.vectorSize ?? 1536))
        setDistance(json.data.distance ?? 'Cosine')
      })
      .catch(() => { if (!cancelled) setLoadError(true) })
    return () => {
      cancelled = true
    }
  }, [])

  const save = async () => {
    if (needsApiKey && !apiKey.trim()) {
      toast.error('API key required for this provider.')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/vector-store', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          baseUrl,
          apiKey: apiKey || undefined,
          collectionName,
          vectorSize: Number(vectorSize) || 1536,
          distance,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(extractError(json.error, 'Failed to save.'))
      setApiKey('')
      toast.success('Vector DB configuration saved.')
    } catch (e) {
      toast.error('Failed to save vector DB', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      const res = await fetch('/api/vector-store', { method: 'POST' })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(extractError(json.error, 'Failed to test vector DB.'))
      toast.success('Vector DB ready.', {
        description: json.data?.collectionName ?? json.data?.provider,
      })
    } catch (e) {
      toast.error('Vector DB not ready', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
            <Layers className="h-4.5 w-4.5" />
          </div>
          <div>
            <CardTitle className="text-xs">Vector DB</CardTitle>
            <p className="text-xs text-muted-foreground">
              Qdrant / Milvus / Pinecone / Chroma for external semantic retrieval. Internal pgvector remains as fallback.
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        {loadError && (
          <div className="md:col-span-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="text-xs text-destructive">
              Failed to load vector DB configuration. Saving may overwrite existing configuration. Reload the page to try again.
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          <Label>Provider</Label>
          <Select value={provider} onValueChange={handleProviderChange}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VECTOR_STORE_PRESETS.map(p => (
                <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {vsPreset?.hint && (
            <p className="text-xs text-warning">{vsPreset.hint}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label>Base URL</Label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={vsPreset?.baseUrlPlaceholder ?? ''}
            className="font-mono text-sm"
            disabled={isInternal}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Collection</Label>
          <Input
            value={collectionName}
            onChange={(e) => setCollectionName(e.target.value)}
            className="font-mono text-sm"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label>Dimension</Label>
            <Input
              value={vectorSize}
              onChange={(e) => setVectorSize(e.target.value)}
              inputMode="numeric"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Distance</Label>
            <Input value={distance} onChange={(e) => setDistance(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <Label>
            API Key{needsApiKey && <span className="text-destructive"> *</span>}
          </Label>
          <Input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={needsApiKey ? 'required' : 'optional'}
            className="font-mono text-sm"
            autoComplete="new-password"
          />
        </div>
        <div className="flex justify-end gap-2 md:col-span-2">
          <Button
            variant="outline"
            size="sm"
            onClick={test}
            disabled={testing || isInternal}
            icon={testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          >
            Test
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={saving || loadError}
            icon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          >
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
