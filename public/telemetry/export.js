// Экспорт видео с телеметрией прямо в браузере (WebCodecs через библиотеку Mediabunny).
// Видео не уходит ни на какой сервер: кадры декодируются, на них рисуется телеметрия, и всё кодируется заново.
import {
  Input, Output, Conversion, BlobSource, BufferTarget, StreamTarget, Mp4OutputFormat, ALL_FORMATS,
  QUALITY_MEDIUM, QUALITY_HIGH, QUALITY_VERY_HIGH, canEncodeVideo, getFirstEncodableAudioCodec,
  VideoSampleSink, AudioSampleSink, CanvasSource, AudioSampleSource,
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

// opts: { segments: [{ file, offset, duration }], target, from, to (время на общей дорожке),
//         height (0 — как в оригинале), quality, mode: 'video' | 'green',
//         draw(ctx, W, H, t), onProgress(0..1), onConversion({ cancel }) }
// Один файл собирается через Conversion (звук копируется без пересжатия),
// несколько частей — склейкой кадр за кадром.
export async function exportVideo(opts) {
  const parts = opts.segments.filter((p) => p.offset < opts.to && p.offset + p.duration > opts.from);
  if (parts.length === 1) return exportSingle(opts, parts[0]);
  return exportConcat(opts, parts);
}

function outSize(vt, height) {
  let W = vt.displayWidth;
  let H = vt.displayHeight;
  if (height && height < Math.min(W, H)) {
    const k = height / Math.min(W, H);
    W = Math.round((W * k) / 2) * 2;
    H = Math.round((H * k) / 2) * 2;
  }
  return { W, H };
}
async function pickCodec(W, H) {
  const codec = (await canEncodeVideo('avc', { width: W, height: H })) ? 'avc' : (await canEncodeVideo('hevc', { width: W, height: H })) ? 'hevc' : null;
  if (!codec) throw new Error('Браузер не умеет записывать видео ' + W + '×' + H + '. Выберите размер поменьше.');
  return codec;
}
async function makeOutput(target) {
  if (target && target.handle) {
    const writable = await target.handle.createWritable();
    return { writable, output: new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable, { chunked: true }) }) };
  }
  const buf = new BufferTarget();
  return { buf, output: new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: buf }) };
}
async function checkTrack(vt, name) {
  if (!vt) throw new Error('В файле ' + name + ' нет видео');
  if (!(await vt.canDecode())) throw new Error('Браузер не умеет читать видео ' + name + ' (' + (vt.codec || 'неизвестный кодек') + '). Попробуйте Chrome или Edge, или перекодируйте видео в H.264.');
}

async function exportSingle(opts, part) {
  const input = new Input({ source: new BlobSource(part.file), formats: ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  await checkTrack(vt, part.file.name);
  const { W, H } = outSize(vt, opts.height);
  const codec = await pickCodec(W, H);
  const { writable, buf, output } = await makeOutput(opts.target);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  const from = Math.max(0, opts.from - part.offset);
  const to = Math.min(part.duration, opts.to - part.offset);
  const green = opts.mode === 'green';

  const conv = await Conversion.init({
    input,
    output,
    trim: { start: from, end: to },
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
        // Время кадра на общей дорожке: при обрезке Mediabunny считает от начала обрезки.
        opts.draw(ctx, W, H, part.offset + from + sample.timestamp);
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
  return { blob: new Blob([buf.buffer], { type: 'video/mp4' }) };
}

// Несколько частей подряд: кадры и звук каждой части идут с её сдвигом на общей дорожке.
async function exportConcat(opts, parts) {
  const inputs = parts.map((p) => new Input({ source: new BlobSource(p.file), formats: ALL_FORMATS }));
  const vts = await Promise.all(inputs.map((i) => i.getPrimaryVideoTrack()));
  for (let k = 0; k < parts.length; k++) await checkTrack(vts[k], parts[k].file.name);
  const { W, H } = outSize(vts[0], opts.height);
  const codec = await pickCodec(W, H);
  const green = opts.mode === 'green';
  const { writable, buf, output } = await makeOutput(opts.target);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  const quality = QUALITY[opts.quality] || QUALITY_HIGH;
  const vsrc = new CanvasSource(canvas, { codec, quality });
  output.addVideoTrack(vsrc);

  let asrc = null;
  let ats = [];
  if (!green) {
    ats = await Promise.all(inputs.map((i) => i.getPrimaryAudioTrack()));
    if (ats.every(Boolean) && (await Promise.all(ats.map((a) => a.canDecode()))).every(Boolean)) {
      const acodec = await getFirstEncodableAudioCodec(output.format.getSupportedAudioCodecs(), {
        numberOfChannels: ats[0].numberOfChannels, sampleRate: ats[0].sampleRate, quality: QUALITY_HIGH,
      });
      if (acodec) {
        asrc = new AudioSampleSource({ codec: acodec, quality: QUALITY_HIGH });
        output.addAudioTrack(asrc);
      }
    }
  }

  let canceled = false;
  const cancelError = () => Object.assign(new Error('Отменено'), { name: 'ConversionCanceledError' });
  if (opts.onConversion) opts.onConversion({ cancel: () => { canceled = true; } });
  await output.start();
  const total = opts.to - opts.from;
  const range = (p) => [Math.max(0, opts.from - p.offset), Math.min(p.duration, opts.to - p.offset)];

  const videoJob = async () => {
    let last = -1;
    for (let k = 0; k < parts.length; k++) {
      const p = parts[k];
      const [a, b] = range(p);
      const sink = new VideoSampleSink(vts[k]);
      for await (const s of sink.samples(a, b)) {
        try {
          if (canceled) throw cancelError();
          const g = p.offset + s.timestamp;
          let ts = Math.max(0, g - opts.from);
          if (ts <= last) ts = last + 0.0001;
          last = ts;
          if (green) {
            ctx.fillStyle = '#00b140';
            ctx.fillRect(0, 0, W, H);
          } else {
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, W, H);
            s.drawWithFit(ctx, { fit: 'contain' });
          }
          opts.draw(ctx, W, H, g);
          await vsrc.add(ts, s.duration);
          if (opts.onProgress) opts.onProgress(Math.min(1, ts / total));
        } finally {
          s.close();
        }
      }
    }
    vsrc.close();
  };
  const audioJob = async () => {
    if (!asrc) return;
    let last = -1;
    for (let k = 0; k < parts.length; k++) {
      const p = parts[k];
      const [a, b] = range(p);
      const sink = new AudioSampleSink(ats[k]);
      for await (const s of sink.samples(a, b)) {
        try {
          if (canceled) throw cancelError();
          const ts = p.offset + s.timestamp - opts.from;
          if (ts + s.duration <= 0 || ts < last) continue;
          s.setTimestamp(Math.max(0, ts));
          last = Math.max(0, ts);
          await asrc.add(s);
        } finally {
          s.close();
        }
      }
    }
    asrc.close();
  };

  try {
    await Promise.all([videoJob(), audioJob()]);
    await output.finalize();
  } catch (e) {
    try { await output.cancel(); } catch (x) { /* уже остановлено */ }
    if (writable) { try { await writable.abort(); } catch (x) { /* уже закрыт */ } }
    throw e;
  }
  if (writable) return { saved: true };
  return { blob: new Blob([buf.buffer], { type: 'video/mp4' }) };
}
