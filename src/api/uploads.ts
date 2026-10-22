import { api, ApiError } from './client';
export interface Job { id: string; state: 'queued' | 'processing' | 'succeeded' | 'failed' | 'canceled'; errorCode: string | null }
export const getJob = (id: string) => api.request<Job>(`/jobs/${encodeURIComponent(id)}`);
/** XHR exposes actual bytes sent; 100% is not processing success. */
export function uploadFile(songId: string, trackId: string, version: number, file: File, key: string, progress: (percent: number) => void): Promise<Job> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const token = api.csrfToken;
    xhr.open('POST', `/api/v1/songs/${encodeURIComponent(songId)}/tracks/${encodeURIComponent(trackId)}/uploads`);
    xhr.timeout = 120_000;
    xhr.setRequestHeader('If-Match', `"${version}"`);
    xhr.setRequestHeader('Idempotency-Key', key);
    if (token) xhr.setRequestHeader('X-CSRF-Token', token);
    xhr.upload.onprogress = e => { if (e.lengthComputable) progress(Math.floor(e.loaded / e.total * 100)); };
    xhr.onerror = xhr.ontimeout = () => reject(new ApiError(0, { code: 'network_error', message: 'Загрузка не подтверждена. Проверьте соединение и повторите файл.' }));
    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { reject(new Error('Некорректный ответ загрузки')); return; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else {
        if (xhr.status === 401 && api.csrfToken === token) { api.csrfToken = null; api.onUnauthorized(); }
        if (data.error?.code === 'csrf_failed' && api.csrfToken === token) api.onCSRF();
        reject(new ApiError(xhr.status, data.error ?? { code: 'upload_error', message: 'Не удалось загрузить файл.' }));
      }
    };
    const form = new FormData(); form.append('file', file); xhr.send(form);
  });
}
