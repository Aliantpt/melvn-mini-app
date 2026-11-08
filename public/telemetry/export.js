// Экспорт видео с телеметрией прямо в браузере (WebCodecs через библиотеку Mediabunny).
// Видео не уходит ни на какой сервер: кадры декодируются, на них рисуется телеметрия, и всё кодируется заново.
import {
  Input, Output, Conversion, BlobSource, BufferTarget, StreamTarget, Mp4OutputFormat, ALL_FORMATS,
  QUALITY_MEDIUM, QUALITY_HIGH, QUALITY_VERY_HIGH, canEncodeVideo,
} from './vendor/mediabunny.min.mjs';

const QUALITY = { medium: QUALITY_MEDIUM, high: QUALITY_HIGH, max: QUALITY_VERY_HIGH };

// Сведения о видео: размер, длительность, частота кадров, кодек.
export async function probeVideo(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) return null;
    let fps = 0;
    try {
      const stats = await vt.computePacketStats(120);
      fps = stats.averagePacketRate;
    } catch (e) { /* не страшно */ }
    return {
      width: vt.displayWidth,
      height: vt.displayHeight,
      codec: vt.codec,
      fps: fps || 30,
      start: await vt.getFirstTimestamp().catch(() => 0),
      duration: await input.computeDuration(),
      decodable: await vt.canDecode().catch(() => false),
    };
  } finally {
    if (input.dispose) input.dispose();
  }
}

// Окно сохранения файла нужно открыть сразу по нажатию кнопки — до любых долгих операций.
export async function pickTarget(suggestedName) {
  if (window.showSaveFilePicker && window.isSecureContext) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Видео MP4', accept: { 'video/mp4': ['.mp4'] } }],
      });
      return { handle };
    } catch (e) {
      if (e && e.name === 'AbortError') return null; // пользователь закрыл окно
    }
  }
  return { download: suggestedName };
}

// opts: { file, target, from, to, height (0 — как в оригинале), quality, mode: 'video' | 'green',
//         draw(ctx, W, H, t), onProgress(0..1), onConversion(conv) }
export async function exportVideo(opts) {
  const input = new Input({ source: new BlobSource(opts.file), formats: ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) throw new Error('В файле нет видео');
  if (!(await vt.canDecode())) throw new Error('Браузер не умеет читать это видео (' + (vt.codec || 'неизвестный кодек') + '). Попробуйте Chrome или Edge, или перекодируйте видео в H.264.');
  let W = vt.displayWidth;
  let H = vt.displayHeight;
  if (opts.height && opts.height < Math.min(W, H)) {
    const k = opts.height / Math.min(W, H);
    W = Math.round((W * k) / 2) * 2;
    H = Math.round((H * k) / 2) * 2;
  }
  const codec = (await canEncodeVideo('avc', { width: W, height: H })) ? 'avc' : (await canEncodeVideo('hevc', { width: W, height: H })) ? 'hevc' : null;
  if (!codec) throw new Error('Браузер не умеет записывать видео ' + W + '×' + H + '. Выберите размер поменьше.');

  let writable = null;
  let target;
  if (opts.target && opts.target.handle) {
    writable = await opts.target.handle.createWritable();
    target = new StreamTarget(writable, { chunked: true });
  } else {
    target = new BufferTarget();
  }
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: writable ? false : 'in-memory' }), target });

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  const from = opts.from || 0;
  const green = opts.mode === 'green';

  const conv = await Conversion.init({
    input,
    output,
    trim: { start: from, end: opts.to },
    showWarnings: false,
    video: {
      codec,
      quality: QUALITY[opts.quality] || QUALITY_HIGH,
      forceTranscode: true,
      processedWidth: W,
      processedHeight: H,
      process: (sample) => {
        if (green) {
          ctx.fillStyle = '#00b140';
          ctx.fillRect(0, 0, W, H);
        } else {
          sample.drawWithFit(ctx, { fit: 'fill' });
        }
        // Время кадра в исходном видео: при обрезке Mediabunny считает от начала обрезки.
        opts.draw(ctx, W, H, sample.timestamp + from);
        return canvas;
      },
    },
    audio: green ? { discard: true } : {},
  });
  if (!conv.isValid) {
    const why = conv.discardedTracks.map((d) => d.reason).join(', ');
    throw new Error('Не получается собрать видео (' + why + ')');
  }
  if (opts.onConversion) opts.onConversion(conv);
  conv.onProgress = (p) => opts.onProgress && opts.onProgress(p);
  try {
    await conv.execute();
  } catch (e) {
    if (writable) { try { await writable.abort(); } catch (x) { /* уже закрыт */ } }
    throw e;
  }
  if (writable) return { saved: true };
  const blob = new Blob([target.buffer], { type: 'video/mp4' });
  return { blob };
}
