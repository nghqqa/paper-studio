import { downloadFile } from '@/lib/download'
import { req } from './net'

export const archiveApi = {
  exportUrl: (pid: string) => `/api/projects/${encodeURIComponent(pid)}/archive/export`,
  downloadArchive: (pid: string, title?: string) =>
    downloadFile(archiveApi.exportUrl(pid), `${title || pid}-archive.zip`),
  importArchive: (file: File, preferredId?: string) => {
    const fd = new FormData()
    fd.append('file', file)
    if (preferredId) fd.append('preferred_id', preferredId)
    return req<{ project: { id: string; title: string; source_format: string }; restored_files: number }>(
      '/api/projects/archive/import',
      { method: 'POST', body: fd },
    )
  },
}
