'use client'

import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md text-center">
        <CardHeader>
          <div className="flex justify-center">
            <AlertCircle className="size-10 text-destructive" />
          </div>
          <CardTitle className="mt-2">Terjadi Kesalahan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">
            {error.message || 'Terjadi kesalahan yang tidak terduga.'}
          </p>
          <Button onClick={() => reset()}>Coba Lagi</Button>
        </CardContent>
      </Card>
    </div>
  )
}
