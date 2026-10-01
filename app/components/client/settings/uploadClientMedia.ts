export async function uploadClientMediaFile(token: string, file: File) {
  const body = new FormData();
  body.append('file', file);
  const response = await fetch('/api/client/media', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || 'Kunne ikke laste opp filen.');
  const url = String(payload.url || '').trim();
  if (!url) throw new Error('Mangler filadresse etter opplasting.');
  return url;
}

export async function uploadClientMediaFiles(token: string, files: File[]) {
  const urls: string[] = [];
  for (const file of files) {
    urls.push(await uploadClientMediaFile(token, file));
  }
  return urls;
}
