(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./vendor/fflate-0.8.2.js"));
  else root.PFMCloudStorage = factory(root.fflate);
})(typeof globalThis !== "undefined" ? globalThis : this, function (gzip) {
  "use strict";
  const INLINE_LIMIT = 850000, PART_LENGTH = 180000, MAX_PARTS = 32, MAX_RAW_BYTES = 32 * 1024 * 1024;
  const workerUrl = typeof document !== "undefined" ? new URL("./cloud-storage-worker.js?v=20261106-perf1",document.currentScript?.src || location.href).href : null;
  let background = null, backgroundDisabled = false, requestId = 0;
  const jobs = new Map();
  function disableBackground() {
    backgroundDisabled = true;
    background?.terminate(); background = null;
    for (const job of jobs.values()) {clearTimeout(job.timer);job.reject(Object.assign(new Error("Background worker unavailable"),{code:"worker-unavailable"}));}
    jobs.clear();
  }
  function backgroundTask(method,args) {
    if (!workerUrl || backgroundDisabled || typeof Worker !== "function") return null;
    try {
      if (!background) {
        background = new Worker(workerUrl);
        background.onmessage = ({data}) => {
          const job = jobs.get(data.id); if (!job) return;
          jobs.delete(data.id); clearTimeout(job.timer);
          if (data.error) job.reject(Object.assign(new Error(data.error.message),{code:data.error.code}));
          else job.resolve(data.result);
        };
        background.onerror = disableBackground;
        background.onmessageerror = disableBackground;
      }
      return new Promise((resolve,reject) => {
        const id = ++requestId, timer = setTimeout(disableBackground,60000);
        jobs.set(id,{resolve,reject,timer});
        try {background.postMessage({id,method,args});}
        catch (error) {disableBackground();}
      });
    } catch (error) {disableBackground();return null;}
  }
  function fail(message) { return Object.assign(new Error(message), {code:"data-loss"}); }
  async function hash(bytes) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,"0")).join("");
  }
  function base64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 16000) binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 16000));
    return btoa(binary);
  }
  function unbase64(text) {
    const binary = atob(text), bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  function isPacked(data) { return data?.storageFormat === "pfm-gzip-v1"; }
  async function pack(data, inlineLimit = INLINE_LIMIT) {
    const task = backgroundTask("pack",{data,inlineLimit});
    if (task) {
      try {return await task;}
      catch (error) {if (error.code !== "worker-unavailable") throw error;await new Promise(resolve=>setTimeout(resolve,0));}
    }
    return packInline(data,inlineLimit);
  }
  async function packInline(data, inlineLimit) {
    if (!gzip) throw new Error("تعذر تحميل مكتبة حفظ البيانات؛ أعد فتح التطبيق");
    const bytes = gzip.strToU8(JSON.stringify(data));
    if (bytes.length > MAX_RAW_BYTES) throw new Error("حجم البيانات أكبر من سعة المزامنة الآمنة؛ بقيت النسخة المحلية محفوظة");
    const checksum = await hash(bytes), compressed = gzip.gzipSync(bytes,{level:6,mtime:0}), encoded = base64(compressed);
    const pieces = [];
    for (let offset = 0; offset < encoded.length; offset += PART_LENGTH) pieces.push(encoded.slice(offset, offset + PART_LENGTH));
    if (pieces.length > MAX_PARTS) throw new Error("تحتاج البيانات إلى مساحة إضافية للمزامنة؛ بقيت النسخة المحلية محفوظة");
    const common = {storageFormat:"pfm-gzip-v1",encoding:"gzip-base64",sha256:checksum,rawBytes:bytes.length,compressedBytes:compressed.length};
    if (encoded.length <= inlineLimit) return {manifest:{...common,parts:pieces},documents:[],encodedBytes:encoded.length};
    const generation = await hash(compressed);
    const documents = pieces.map((payload,index) => ({id:`snapshot-${generation}-${index}`,data:{snapshot:generation,index,payload}}));
    return {manifest:{...common,generation,partIds:documents.map(part=>part.id)},documents,encodedBytes:encoded.length};
  }
  async function readPieces(data,readPart) {
    if (data.encoding !== "gzip-base64" || !/^[a-f0-9]{64}$/.test(data.sha256 || "") || !Number.isInteger(data.rawBytes) || data.rawBytes < 1 || data.rawBytes > MAX_RAW_BYTES) throw fail("بيانات السحابة غير مكتملة أو غير متوافقة؛ لم تُستبدل النسخة المحلية");
    let pieces;
    if (Array.isArray(data.parts) && !data.partIds) pieces = data.parts;
    else if (Array.isArray(data.partIds) && !data.parts && readPart) {
      if (!data.partIds.length || data.partIds.length > MAX_PARTS || !/^[a-f0-9]{64}$/.test(data.generation || "")) throw fail("قائمة أجزاء السحابة غير صالحة");
      pieces = await Promise.all(data.partIds.map(async (id,index) => {
        if (id !== `snapshot-${data.generation}-${index}`) throw fail("مرجع جزء السحابة غير صالح");
        const part = await readPart(id);
        if (!part || part.snapshot !== data.generation || part.index !== index) throw fail("جزء من نسخة السحابة مفقود؛ بقيت البيانات المحلية محفوظة");
        return part.payload;
      }));
    } else throw fail("لم تكتمل قراءة أجزاء نسخة السحابة");
    if (!pieces.length || pieces.length > MAX_PARTS || pieces.some(part => typeof part !== "string" || !part.length || part.length > PART_LENGTH)) throw fail("محتوى أحد أجزاء السحابة غير صالح");
    return pieces;
  }
  async function unpack(data, readPart) {
    // Older documents keep their original object shape until the next successful save.
    if (!isPacked(data)) return data;
    const pieces = await readPieces(data,readPart);
    const {partIds,...inline} = data;
    const task = backgroundTask("unpack",{data:{...inline,parts:pieces}});
    if (task) {
      try {return await task;}
      catch (error) {if (error.code !== "worker-unavailable") throw error;await new Promise(resolve=>setTimeout(resolve,0));}
    }
    return unpackInline(data,pieces);
  }
  async function unpackInline(data,pieces) {
    let bytes;
    try {
      const compressed = unbase64(pieces.join(""));
      if (compressed.length !== data.compressedBytes || compressed.length < 18) throw fail("حجم نسخة السحابة غير متطابق");
      const size = new DataView(compressed.buffer,compressed.byteOffset + compressed.length - 4,4).getUint32(0,true);
      if (size !== data.rawBytes) throw fail("حجم البيانات المسترجعة غير متطابق");
      bytes = gzip.gunzipSync(compressed);
    } catch (error) { throw fail("تعذر التحقق من نسخة السحابة المضغوطة؛ بقيت النسخة المحلية محفوظة"); }
    if (bytes.length !== data.rawBytes || await hash(bytes) !== data.sha256) throw fail("لم تتطابق بصمة نسخة السحابة؛ لم تُطبّق على الجهاز");
    try { return JSON.parse(gzip.strFromU8(bytes)); }
    catch (error) { throw fail("صيغة نسخة السحابة غير صالحة"); }
  }
  return {pack,unpack,isPacked,INLINE_LIMIT,PART_LENGTH,MAX_PARTS,backgroundState:()=>({active:!!background,disabled:backgroundDisabled,pending:jobs.size})};
});
