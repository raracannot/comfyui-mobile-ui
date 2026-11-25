/* ComfyUI Mobile UI - touch node editor.
 *
 * Everything is plain ES2020, no framework, no network beyond ComfyUI's own
 * API. Structure:
 *   boot        connect, fetch node schemas, restore last workflow
 *   graph       normalise / render / serialise a UI-format workflow
 *   canvas      pan, pinch, node drag, link drag
 *   sheet       the node inspector - the real editing surface on a phone
 *   run         convert -> POST /prompt -> WebSocket progress -> results
 *   panels      workflows, gallery, queue, nodes, settings
 */
"use strict";

(function () {
  const B = window.__MUI_BOOT__ || {};

  /* Where ComfyUI's own endpoints live, as this page sees them. Derived from
   * the address bar rather than from the server, so a reverse proxy works
   * whether or not it strips its own prefix:
   *   http://host/mobile/            -> /
   *   https://host/comfy/mobile/     -> /comfy/     (proxy strips, or not)
   */
  function deriveApiRoot() {
    const p = location.pathname;
    if (p.endsWith("/mobile/")) return p.slice(0, -"mobile/".length) || "/";
    if (p.endsWith("/mobile")) return p.slice(0, -"mobile".length) || "/";
    return B.apiRoot || "/";
  }

  const API_ROOT = deriveApiRoot();
  const api = (p) => API_ROOT + p;
  const rel = (p) => p;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const HEAD = 30, ROW = 24;

  /* Chinese labels for the parameters that show up on this install. The raw
   * English key stays visible beside it: people read these workflows on a
   * desktop too, and the two names have to line up. Unknown keys fall through
   * to the English name rather than a guess. */
  const ZH = {
    width: "宽度", height: "高度", length: "帧数", batch_size: "批次数量",
    steps: "步数", cfg: "提示词强度", seed: "种子", noise_seed: "噪声种子",
    denoise: "降噪强度", sampler_name: "采样器", scheduler: "调度器",
    prompt: "提示词", text: "文本", negative_prompt: "负向提示词",
    clip_name: "CLIP 模型", vae_name: "VAE 模型", unet_name: "UNet 模型",
    model_name: "模型", lora_name: "LoRA 模型", weight_dtype: "权重量化",
    strength_model: "模型强度", strength_clip: "CLIP 强度",
    filename_prefix: "文件名前缀", image: "图片", images: "图像", mask: "遮罩",
    scale: "缩放倍数", upscale_method: "放大算法", crop: "裁剪方式",
    format: "格式", codec: "编码器", bit_depth: "位深", color_space: "色彩空间",
    fps: "帧率", device: "运行设备", precision: "精度",
    shift: "偏移", sampling: "采样方式", sigma: "噪声强度", sigmas: "噪声序列",
    ref_image_size: "参考图尺寸", expression: "表达式", value: "数值",
    control_after_generate: "每次运行后", type: "类型", model: "模型",
    clip: "CLIP", vae: "VAE", latent: "潜空间", samples: "潜变量",
    positive: "正向条件", negative: "负向条件", conditioning: "条件",
    chunk_length: "分块长度", temporal_overlap: "时序重叠", anchor_strength: "锚定强度",
    mode: "模式", align: "对齐", keep_proportion: "保持比例", offload_after_upscale: "放大后卸载",
    strength: "强度", start_percent: "起始比例", end_percent: "结束比例",
    temperature: "温度", max_tokens: "最大长度", quality: "质量",
    autogrow: "自动扩展", resize_mode: "缩放模式", interpolation: "插值方式",
    sampler: "采样器", sigmas_type: "噪声类型", noise_type: "噪声类型",
  };

  function zhLabel(name) {
    return Object.prototype.hasOwnProperty.call(ZH, name) ? ZH[name] : null;
  }

  /* Chinese names for the node types this install actually uses. ComfyUI's own
   * /i18n only carries third-party defs (1400 entries, and KSampler is not one
   * of them), so the core names are here. Anything missing falls back to the
   * English type name - never a guess. */
  const NODE_ZH = {
    CheckpointLoaderSimple: "检查点加载器", UNETLoader: "UNet 加载器",
    CLIPLoader: "CLIP 加载器", DualCLIPLoader: "双 CLIP 加载器", VAELoader: "VAE 加载器",
    LoraLoader: "LoRA 加载器", LoraLoaderModelOnly: "LoRA 加载器（仅模型）",
    CLIPTextEncode: "CLIP 文本编码", CLIPSetLastLayer: "CLIP 设置最后一层",
    ConditioningZeroOut: "负向条件置零", ConditioningCombine: "条件合并",
    ConditioningAverage: "条件平均", ConditioningSetArea: "条件限定区域",
    EmptyLatentImage: "空 Latent", EmptySD3LatentImage: "空 Latent（SD3）",
    KSampler: "K 采样器", KSamplerAdvanced: "高级 K 采样器",
    SamplerCustomAdvanced: "自定义采样器（高级）", SamplerCustom: "自定义采样器",
    BasicScheduler: "基础调度器", KSamplerSelect: "采样器选择",
    RandomNoise: "随机噪声", ManualSigmas: "手动噪声序列",
    ModelSamplingAuraFlow: "模型采样（AuraFlow）", ModelSamplingSD3: "模型采样（SD3）",
    ModelSamplingDiscrete: "模型采样（离散）",
    VAEDecode: "VAE 解码", VAEEncode: "VAE 编码", VAEEncodeForInpaint: "局部重绘编码",
    VAEDecodeTiled: "VAE 解码（分块）",
    SaveImage: "保存图像", PreviewImage: "预览图像", LoadImage: "加载图像",
    LoadImageMask: "加载遮罩", ImageScale: "图像缩放", ImageScaleBy: "图像按倍数缩放",
    ImageBatch: "图像批次", ImageBlend: "图像混合", ImageInvert: "图像反色",
    ImageToMask: "图像转遮罩", MaskBlur: "遮罩模糊", GrowMask: "遮罩扩展",
    UpscaleModelLoader: "放大模型加载器", ImageUpscaleWithModel: "模型放大图像",
    UltimateSDUpscale: "分块放大", LatentUpscale: "潜空间放大",
    LatentUpscaleBy: "潜空间放大（倍数）", SetLatentNoiseMask: "设置潜空间遮罩",
    ControlNetLoader: "控制网加载器", ControlNetApply: "控制网应用",
    ControlNetApplyAdvanced: "控制网应用（高级）",
    SaveVideo: "保存视频", CreateVideo: "创建视频", VAEDecodeAudio: "音频解码",
    PrimitiveInt: "整数", PrimitiveFloat: "小数", PrimitiveString: "文本",
    PrimitiveStringMultiline: "多行文本", PrimitiveBoolean: "布尔",
    Note: "便签", MarkdownNote: "说明文档", Reroute: "中继",
    MiniMaxH3ReferenceToVideo: "H3 参考生视频", MiniMaxH3ImageToVideo: "H3 图生视频",
    MinimaxH3LatentUpscaler3D: "H3 潜空间放大", MMH3TemporalSplitParams: "H3 时序分块参数",
    LTXVSeparateAVLatent: "分离音视频潜空间", LTXVConcatAVLatent: "合并音视频潜空间",
    Florence2Run: "Florence2 反推", WD14Tagger: "WD14 打标",
    TextEncodeQwenImageEdit: "千问图像编辑编码", CLIPVisionLoader: "视觉编码加载器",
  };

  function nodeZh(type) {
    return Object.prototype.hasOwnProperty.call(NODE_ZH, type) ? NODE_ZH[type] : null;
  }
  const SVG_OFFSET = 20000;
  const HUES = [212, 264, 190, 330, 46, 160];

  function hue(type) {
    let h = 0;
    for (let i = 0; i < (type || "").length; i++) h = (h * 31 + type.charCodeAt(i)) | 0;
    return HUES[Math.abs(h) % HUES.length];
  }

  function randId() {
    let s = "";
    for (let i = 0; i < 16; i++) s += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)];
    return s;
  }

  const S = {
    doc: null,
    oi: {},
    oiFull: {},
    nodes: new Map(),
    links: new Map(),
    nextLinkId: 1,
    sel: null,
    view: { x: 0, y: 0, z: 1 },
    dirty: false,
    running: null,
    donePrompt: null,
    clientId: randId(),
    ws: null,
    wsRetry: 0,
    wfPath: null,
    wfName: "",
    history: [],
    lastResult: null,
    oiError: "",
  };

  /* ==================================================================== utils */

  let toastTimer = 0;
  function toast(msg, isErr) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast show" + (isErr ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = "toast"; }, isErr ? 5000 : 2400);
  }

  function setSub(text, cls) {
    const el = $("#wfSub");
    el.textContent = text;
    el.className = cls || "";
  }

  function updateTitle() {
    $("#wfName").textContent = S.wfName || "未打开工作流";
    $("#wfSub").classList.toggle("dirty", S.dirty);
  }

  /* ==================================================================== boot */

  /* Which workflow to open on a cold start. Z-Image 文生图 is the one used most
   * here, so it wins; anything else falls back to alphabetical order, which is
   * predictable, rather than "whatever was modified last". */
  function pickDefaultWorkflow(list) {
    if (!list || !list.length) return null;
    const isZ = (w) => /z[-\s]?image/i.test(w.path);
    const isT2I = (w) => /文生图|txt2img|text[_\s-]?to[_\s-]?image/i.test(w.path);
    const plain = (w) => !/_(gguf|lora|canny|controlnet|pose|边缘|控制|姿态|放大)/i.test(w.name);

    const zt = list.filter((w) => isZ(w) && isT2I(w) && plain(w));
    if (zt.length) {
      const exact = zt.find((w) => w.name === "Z-Image_文生图") || zt[0];
      return exact;
    }
    const anyZ = list.filter(isZ);
    if (anyZ.length) return anyZ[0];

    return list.slice().sort((a, b) =>
      a.path.localeCompare(b.path, "zh", { numeric: true, sensitivity: "base" }))[0];
  }

  async function boot() {
    bindGlobal();
    /* Before anything can open a panel, so the guard always sits at the bottom
     * of the stack and every overlay is pushed above it. */
    armBackGuard();
    updateTitle();
    const ok = await loadObjectInfo(4);
    if (ok) {
      setSub(Object.keys(S.oi).length + " 种节点已就绪");
    } else {
      setSub("节点表未加载（点这里重试）", "err");
      $("#wfSub").style.pointerEvents = "auto";
      $("#wfSub").onclick = async () => {
        setSub("正在重试…");
        if (await loadObjectInfo(4)) {
          render();
          setSub(Object.keys(S.oi).length + " 种节点已就绪");
          toast("节点表已就绪");
        } else {
          setSub("仍然失败：" + (S.oiError || ""), "err");
        }
      };
      toast("节点表没加载出来，参数会显示不全。点顶部副标题重试。", true);
    }

    connectWS();

    const last = localStorage.getItem("mui.last");
    if (last) {
      await openWorkflow(last, true).catch(() => {});
    }
    if (!S.doc) {
      const list = await listWorkflows();
      const pick = pickDefaultWorkflow(list);
      if (pick) await openWorkflow(pick.path, true).catch(() => {});
    }
    if (!S.doc) openPanel("workflows");
    else setSub(S.doc.nodes.length + " 个节点 · " + (S.wfPath || ""));
  }

  function bindGlobal() {
    $("#btnMenu").addEventListener("click", () => openPanel("workflows"));
    $("#btnRun").addEventListener("click", runOrStop);
    $("#panelBack").addEventListener("click", closePanel);
    $("#sheetClose").addEventListener("click", closeSheet);
    $("#scrim").addEventListener("click", () => { closeSheet(); });
    $("#dock").addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const act = b.dataset.act;
      if (act === "fit") fitAll();
      else if (act === "add") openPanel("nodes");
      else if (act === "nodelist") openPanel("nodelist");
      else if (act === "gallery") openPanel("gallery");
      else if (act === "prompts") openPanel("prompts");
    });
    const vp = $("#viewport");
    vp.addEventListener("pointerdown", onDown);
    vp.addEventListener("pointermove", onMove);
    vp.addEventListener("pointerup", onUp);
    vp.addEventListener("pointercancel", onUp);
    vp.addEventListener("contextmenu", (e) => e.preventDefault());
    vp.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0016));
    }, { passive: false });

    window.addEventListener("beforeunload", (e) => {
      if (S.dirty) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  /* ================================================================ workflows */

  async function listWorkflows() {
    try {
      const r = await (await fetch(rel("api/workflows"))).json();
      return r.workflows || [];
    } catch (e) {
      return [];
    }
  }

  async function openWorkflow(path, silent) {
    const r = await fetch(rel("api/workflow?path=" + encodeURIComponent(path)));
    const j = await r.json();
    if (j.error) { toast(j.error, true); return; }
    loadDoc(j.workflow, j.path);
    if (!silent) toast("已打开 " + S.wfName);
  }

  function loadDoc(doc, path) {
    if (!doc || !Array.isArray(doc.nodes)) { toast("这个文件不是 ComfyUI 工作流", true); return; }
    doc.links = doc.links || [];
    doc.nodes.forEach((n) => {
      if (!Array.isArray(n.pos)) n.pos = [0, 0];
      if (!Array.isArray(n.size)) n.size = [190, 60];
      if (!n.inputs) n.inputs = [];
      if (!n.outputs) n.outputs = [];
    });
    S.doc = doc;
    S.nodes = MUConv.nodeTable(doc);
    S.links = MUConv.linkTable(doc);
    let maxLink = 0;
    S.links.forEach((l) => { maxLink = Math.max(maxLink, l.id); });
    S.nextLinkId = Math.max(maxLink, doc.last_link_id || 0) + 1;
    S.sel = null;
    S.dirty = false;
    S.wfPath = path || "";
    S.wfName = String(path || "").replace(/\.json$/i, "").split("/").pop();
    localStorage.setItem("mui.last", S.wfPath);
    closeSheet();
    render();
    focusInitial();
    updateTitle();
    setSub(S.doc.nodes.length + " 个节点 · " + S.wfPath);
    $("#hint").classList.remove("hide");
  }

  /* =================================================================== render */

  function info(n) {
    return S.oi[n.type] || { dn: n.type, in: { required: {}, optional: {} }, out: [], outn: [] };
  }

  function values(n) { return MUConv.getValues(n, info(n)); }

  function nodeWidth(n) {
    return clamp((n.size && n.size[0]) || 190, 128, 300);
  }

  function portY(k) { return HEAD + k * ROW + ROW / 2; }

  /** Every input that gets a dot and a name on the canvas. A widget-backed
   *  input only appears once something is wired to it - same rule as ComfyUI's
   *  own canvas - but here the name is always printed, because an unlabelled
   *  dot on a phone tells you nothing. */
  function inputRows(n) {
    const ws = new Set(MUConv.widgetSpecs(info(n)).map((s) => s[0]));
    const rows = [];
    n.inputs.forEach((inp, i) => {
      const isW = ws.has(inp.name);
      if (inp.link != null || !isW) {
        rows.push({ i, name: inp.name, type: inp.type, linked: inp.link != null, widget: isW });
      }
    });
    return rows;
  }

  function inputSlots(n) {
    return inputRows(n).map((r) => r.i);
  }

  /** Widget values shown on the card. Wired ones live in inputRows instead. */
  function cardWidgets(n) {
    return MUConv.widgetSpecs(info(n))
      .map((s) => s[0])
      .filter((name) => !isLinked(n, name))
      .slice(0, 7);
  }

  /** Just enough markdown for note nodes, which are otherwise a wall of ## and
   *  ** on a phone. Input is escaped first, so the result is safe to inject. */
  function miniMd(s) {
    let t = esc(s);
    t = t.replace(/^\s*#{1,6}\s*/gm, "");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    t = t.replace(/\[([^\]]+)\]\((?:https?:|\/\/)[^)]+\)/g, "$1");
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/^\s*[-*]\s+/gm, "· ");
    return t;
  }

  function bodyHTML(n) {
    if (n.type === "MarkdownNote" || n.type === "Note") {
      const t = (n.widgets_values || [])[0] || "";
      return '<div class="row"><div class="noteText">' + miniMd(String(t).slice(0, 320)) + "</div></div>";
    }
    const v = values(n);
    const parts = [];

    for (const r of inputRows(n)) {
      parts.push('<div class="prow"><span class="plab">' + esc(r.name) + "</span></div>");
    }

    let widgetRows = 0;
    for (const name of cardWidgets(n)) {
      const val = v[name];
      if (val === undefined) continue;
      let text = Array.isArray(val) ? "[" + val.length + " 项]"
        : (val !== null && typeof val === "object") ? "{…}"
        : String(val);
      if (text.length > 38) text = text.slice(0, 38) + "…";
      parts.push('<div class="wrow"><span class="k">' + esc(name) + '</span>' +
        '<span class="v">' + esc(text) + "</span></div>");
      widgetRows++;
    }

    const img = imageWidget(n);
    if (img) {
      parts.push('<img class="thumb" loading="lazy" src="' + esc(api("view?filename=" + encodeURIComponent(img) +
        "&type=input&preview=jpeg;60")) + '" onerror="this.style.display=\'none\'">');
    }
    if (!widgetRows) {
      // nodes whose values are declared as plain sockets still usually carry
      // something in widgets_values; show it rather than an empty card
      const raw = (n.widgets_values || []).filter((x) => x != null && typeof x !== "object");
      if (raw.length) {
        parts.push('<div class="wrow"><span class="v">' + esc(String(raw[0]).slice(0, 40)) + "</span></div>");
      }
    }
    if (!parts.length) parts.push('<div class="wrow"><span class="v">—</span></div>');
    return parts.join("");
  }

  function imageWidget(n) {
    const v = values(n);
    const cand = v.image || v.image_file || null;
    if (typeof cand === "string" && /\.(png|jpe?g|webp|gif|bmp)$/i.test(cand)) return cand;
    return null;
  }

  function buildNode(n) {
    const inf = info(n);
    const el = document.createElement("div");
    el.className = "node";
    if (n.type === "MarkdownNote" || n.type === "Note") el.classList.add("note");
    if (n.mode === 2) el.classList.add("mute");
    if (n.mode === 4) el.classList.add("bypass");
    el.dataset.id = n.id;
    el.style.width = nodeWidth(n) + "px";
    el.style.left = n.pos[0] + "px";
    el.style.top = n.pos[1] + "px";
    el.style.setProperty("--h", hue(n.type));

    const title = n.title || nodeZh(n.type) || inf.dn || n.type;
    const tag = n.mode === 2 ? '<span class="tag">静音</span>' : n.mode === 4 ? '<span class="tag">旁路</span>' : "";
    const ins = inputRows(n);
    const rowCount = ins.length + cardWidgets(n).length;
    const minH = HEAD + Math.max(rowCount, n.outputs.length) * ROW + 10;
    el.style.minHeight = minH + "px";

    el.innerHTML =
      '<div class="nhead"><span class="nm">' + esc(title) + "</span>" + tag + "</div>" +
      '<div class="nbody">' + bodyHTML(n) + "</div>";

    ins.forEach((r, k) => {
      const d = document.createElement("span");
      d.className = "p in" + (r.linked ? " linked" : "");
      d.dataset.i = r.i;
      d.dataset.type = r.type || "*";
      d.dataset.dir = "in";
      d.style.top = portY(k) + "px";
      el.appendChild(d);
    });
    n.outputs.forEach((out, i) => {
      const linked = out.links && out.links.length;
      const d = document.createElement("span");
      d.className = "p out" + (linked ? " linked" : "");
      d.dataset.i = i;
      d.dataset.type = out.type || "*";
      d.dataset.dir = "out";
      d.style.top = portY(i) + "px";
      el.appendChild(d);
    });
    return el;
  }

  function render() {
    const layer = $("#nodes");
    layer.innerHTML = "";
    if (!S.doc) return;
    const arr = Array.from(S.nodes.values()).sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const n of arr) {
      const el = buildNode(n);
      layer.appendChild(el);
      n.__el = el;
    }
    layoutLinks();
    markSelection();
  }

  function updateNodePreview(id) {
    const n = S.nodes.get(id);
    if (!n || !n.__el) return;
    const b = n.__el.querySelector(".nbody");
    if (b) b.innerHTML = bodyHTML(n);
  }

  /* ==================================================================== links */

  function linkPath(x1, y1, x2, y2) {
    const dx = Math.max(28, Math.abs(x2 - x1) * 0.45);
    return "M" + x1 + "," + y1 + " C" + (x1 + dx) + "," + y1 + " " + (x2 - dx) + "," + y2 + " " + x2 + "," + y2;
  }

  function endpoint(l, at) {
    const n = S.nodes.get(at === "out" ? l.origin : l.target);
    if (!n) return null;
    if (at === "out") {
      const slot = l.oslot;
      if (slot < 0 || slot >= n.outputs.length) return null;
      return [n.pos[0] + nodeWidth(n), n.pos[1] + portY(slot)];
    }
    const k = inputSlots(n).indexOf(l.tslot);
    if (k < 0) return null;
    return [n.pos[0], n.pos[1] + portY(k)];
  }

  function layoutLinks() {
    const g = $("#linkLayer");
    g.innerHTML = "";
    if (!S.doc) return;
    S.links.forEach((l) => {
      const a = endpoint(l, "out");
      const b = endpoint(l, "in");
      if (!a || !b) return;
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("class", "lk");
      p.setAttribute("d", linkPath(a[0] + SVG_OFFSET, a[1] + SVG_OFFSET, b[0] + SVG_OFFSET, b[1] + SVG_OFFSET));
      p.dataset.id = l.id;
      g.appendChild(p);
      l.__el = p;
    });
  }

  function updateNodeLinks(id) {
    S.links.forEach((l) => {
      if (l.origin !== id && l.target !== id) return;
      const a = endpoint(l, "out");
      const b = endpoint(l, "in");
      if (!a || !b || !l.__el) return;
      l.__el.setAttribute("d", linkPath(a[0] + SVG_OFFSET, a[1] + SVG_OFFSET, b[0] + SVG_OFFSET, b[1] + SVG_OFFSET));
    });
  }

  function connect(outNode, outSlot, inNode, inSlot) {
    const src = S.nodes.get(outNode);
    const dst = S.nodes.get(inNode);
    if (!src || !dst) return;
    const outType = (src.outputs[outSlot] && src.outputs[outSlot].type) || "*";
    const inType = (dst.inputs[inSlot] && dst.inputs[inSlot].type) || "*";
    if (!MUConv.typesCompatible(outType, inType)) {
      toast("接不上：" + outType + " → " + inType, true);
      return;
    }
    // an input takes one link
    for (const l of Array.from(S.links.values())) {
      if (l.target === inNode && l.tslot === inSlot) S.links.delete(l.id);
    }
    const id = S.nextLinkId++;
    S.links.set(id, {
      id, origin: outNode, oslot: outSlot, target: inNode, tslot: inSlot, type: outType,
    });
    S.dirty = true;
    render();
    updateTitle();
  }

  function disconnect(inNode, inSlot) {
    for (const l of Array.from(S.links.values())) {
      if (l.target === inNode && l.tslot === inSlot) S.links.delete(l.id);
    }
    S.dirty = true;
    render();
    updateTitle();
  }

  /* =================================================================== canvas */

  const ptr = new Map();
  let g = null;
  let moved = 0;
  let t0 = 0;

  function vpRect() { return $("#viewport").getBoundingClientRect(); }

  function applyView() {
    const w = $("#world");
    w.style.transform =
      "translate(" + S.view.x + "px," + S.view.y + "px) scale(" + S.view.z + ")";
    // Ports are sized in graph units but compensated for zoom so a finger has a
    // reasonable target when zoomed out. Capped well below PORT_STEP so they
    // never merge into each other or cover the node's text.
    const pw = clamp(14 / S.view.z, 14, 20);
    w.style.setProperty("--pw", pw + "px");
  }

  function toGraph(clientX, clientY) {
    const r = vpRect();
    return [
      (clientX - r.left - S.view.x) / S.view.z,
      (clientY - r.top - S.view.y) / S.view.z,
    ];
  }

  function zoomAt(lx, ly, factor) {
    const z1 = clamp(S.view.z * factor, 0.04, 2.4);
    const k = z1 / S.view.z;
    S.view.x = lx - (lx - S.view.x) * k;
    S.view.y = ly - (ly - S.view.y) * k;
    S.view.z = z1;
    applyView();
  }

  function fitAll() {
    if (!S.doc || !S.nodes.size) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    S.nodes.forEach((n) => {
      const w = nodeWidth(n);
      const h = Math.max(70, (n.__el ? n.__el.offsetHeight : 90));
      minX = Math.min(minX, n.pos[0]);
      minY = Math.min(minY, n.pos[1]);
      maxX = Math.max(maxX, n.pos[0] + w);
      maxY = Math.max(maxY, n.pos[1] + h);
    });
    const r = vpRect();
    const pad = 24;
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    const z = clamp(Math.min((r.width - pad * 2) / bw, (r.height - pad * 2) / bh), 0.04, 1.4);
    S.view = {
      z,
      x: r.width / 2 - ((minX + maxX) / 2) * z,
      y: r.height / 2 - ((minY + maxY) / 2) * z,
    };
    applyView();
  }

  /** Opening view. A big graph fitted to a 390px screen lands around 0.1x, where
   *  nothing is tappable, so below that we open at a readable scale - centred on
   *  the busiest node, which is where the graph is actually used (the top-left
   *  corner of a real workflow is usually full of documentation notes). */
  function focusInitial() {
    fitAll();
    if (S.view.z >= 0.28 || !S.nodes.size) return;
    const deg = new Map();
    S.links.forEach((l) => {
      deg.set(l.origin, (deg.get(l.origin) || 0) + 1);
      deg.set(l.target, (deg.get(l.target) || 0) + 1);
    });
    let best = null, bestScore = -1;
    S.nodes.forEach((n) => {
      if (n.type === "MarkdownNote" || n.type === "Note") return;
      const score = deg.get(n.id) || 0;
      if (score > bestScore) { best = n; bestScore = score; }
    });
    if (!best) return;
    const z = 0.5;
    const r = vpRect();
    S.view = {
      z,
      x: r.width / 2 - (best.pos[0] + nodeWidth(best) / 2) * z,
      y: (r.height - 130) / 2 - (best.pos[1] + 46) * z,
    };
    applyView();
  }

  function focusNode(id) {    const n = S.nodes.get(id);
    if (!n) return;
    const r = vpRect();
    const z = clamp(Math.max(S.view.z, 0.5), 0.1, 1.2);
    S.view = {
      z,
      x: r.width / 2 - (n.pos[0] + nodeWidth(n) / 2) * z,
      y: r.height / 2 - (n.pos[1] + 60) * z,
    };
    applyView();
    selectNode(id);
  }

  function onDown(e) {
    const r = vpRect();
    ptr.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
    try { $("#viewport").setPointerCapture(e.pointerId); } catch (_) {}
    moved = 0;
    t0 = Date.now();

    if (ptr.size === 2) { startPinch(); return; }
    if (ptr.size > 2) return;

    const t = e.target;
    const portEl = t.closest ? t.closest(".p") : null;
    if (portEl) {
      const nodeEl = portEl.closest(".node");
      g = {
        type: "link",
        nodeId: +nodeEl.dataset.id,
        dir: portEl.dataset.dir,
        idx: +portEl.dataset.i,
      };
      drawGhost(e);
      return;
    }
    const nodeEl = t.closest ? t.closest(".node") : null;
    if (nodeEl) {
      const id = +nodeEl.dataset.id;
      const n = S.nodes.get(id);
      g = { type: "node", id, px: n.pos[0], py: n.pos[1] };
      return;
    }
    g = { type: "pan" };
  }

  function startPinch() {
    const pts = Array.from(ptr.values());
    const [a, b] = pts;
    const d = Math.max(12, Math.hypot(a.x - b.x, a.y - b.y));
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    g = {
      type: "pinch",
      d0: d, z0: S.view.z,
      gx: (mx - S.view.x) / S.view.z,
      gy: (my - S.view.y) / S.view.z,
    };
  }

  function onMove(e) {
    const p = ptr.get(e.pointerId);
    if (!p) return;
    const r = vpRect();
    const lx = e.clientX - r.left, ly = e.clientY - r.top;
    const dx = lx - p.x, dy = ly - p.y;
    p.x = lx; p.y = ly;
    moved += Math.abs(dx) + Math.abs(dy);

    if (!g) return;

    if (g.type === "pinch") {
      const pts = Array.from(ptr.values());
      if (pts.length < 2) return;
      const [a, b] = pts;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const z = clamp(g.z0 * (d / g.d0), 0.04, 2.4);
      S.view.z = z;
      S.view.x = mx - g.gx * z;
      S.view.y = my - g.gy * z;
      applyView();
      return;
    }
    if (g.type === "pan") {
      S.view.x += dx; S.view.y += dy;
      applyView();
      return;
    }
    if (g.type === "node") {
      const n = S.nodes.get(g.id);
      n.pos[0] += dx / S.view.z;
      n.pos[1] += dy / S.view.z;
      n.__el.style.left = n.pos[0] + "px";
      n.__el.style.top = n.pos[1] + "px";
      updateNodeLinks(g.id);
      S.dirty = true;
      return;
    }
    if (g.type === "link") {
      drawGhost(e);
      return;
    }
  }

  function onUp(e) {
    const had = ptr.size;
    ptr.delete(e.pointerId);

    if (g && g.type === "link") {
      clearGhost();
      finishLink(e);
    } else if (g && g.type !== "pinch" && moved < 12 && Date.now() - t0 < 600) {
      handleTap(g);
    }

    if (g && g.type === "pinch" && ptr.size === 1) {
      g = { type: "pan" };
      return;
    }
    if (ptr.size === 0) {
      g = null;
      if (S.dirty) updateTitle();
    }
    if (!had) return;
  }

  function handleTap(gesture) {
    if (gesture.type === "node") {
      selectNode(gesture.id);
      openSheet(gesture.id);
      hideHint();
    } else {
      selectNode(null);
      closeSheet();
    }
  }

  function hideHint() { $("#hint").classList.add("hide"); }

  let ghostEl = null;
  function drawGhost(e) {
    if (!ghostEl) {
      ghostEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
      ghostEl.setAttribute("class", "ghost");
      $("#linkLayer").appendChild(ghostEl);
    }
    const n = S.nodes.get(g.nodeId);
    if (!n) return;
    const isOut = g.dir === "out";
    const x = n.pos[0] + (isOut ? nodeWidth(n) : 0);
    const k = isOut ? g.idx : Math.max(0, inputSlots(n).indexOf(g.idx));
    const y = n.pos[1] + portY(k);
    const [gx, gy] = toGraph(e.clientX, e.clientY);
    ghostEl.setAttribute("d", isOut
      ? linkPath(x + SVG_OFFSET, y + SVG_OFFSET, gx + SVG_OFFSET, gy + SVG_OFFSET)
      : linkPath(gx + SVG_OFFSET, gy + SVG_OFFSET, x + SVG_OFFSET, y + SVG_OFFSET));
  }

  function clearGhost() {
    if (ghostEl && ghostEl.parentNode) ghostEl.parentNode.removeChild(ghostEl);
    ghostEl = null;
  }

  function finishLink(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const target = el && el.closest ? el.closest(".p") : null;
    if (!target) return;
    const nodeEl = target.closest(".node");
    if (!nodeEl) return;
    const tid = +nodeEl.dataset.id;
    const tdir = target.dataset.dir;
    if (tdir === g.dir) { toast("要连到另一侧的圆点", true); return; }
    if (tid === g.nodeId) return;

    const outNode = g.dir === "out" ? g.nodeId : tid;
    const outSlot = g.dir === "out" ? g.idx : +target.dataset.i;
    const inNode = g.dir === "in" ? g.nodeId : tid;
    const inSlot = g.dir === "in" ? g.idx : +target.dataset.i;
    connect(outNode, outSlot, inNode, inSlot);
    hideHint();
  }

  function selectNode(id) {
    S.sel = id;
    markSelection();
  }

  function markSelection() {
    $$(".node").forEach((el) => el.classList.toggle("sel", +el.dataset.id === S.sel));
    S.links.forEach((l) => {
      if (l.__el) l.__el.classList.toggle("sel", S.sel != null && (l.origin === S.sel || l.target === S.sel));
    });
  }

  /* ==================================================================== sheet */

  function isLinked(n, name) {
    for (const inp of n.inputs) if (inp.name === name && inp.link != null) return true;
    return false;
  }

  /** Which node feeds an input, so the sheet can say "值来自 #123 Int (Full)". */
  function linkSource(n, name) {
    const inp = n.inputs.find((x) => x.name === name);
    if (!inp || inp.link == null) return null;
    const l = S.links.get(inp.link);
    if (!l) return null;
    const src = S.nodes.get(l.origin);
    if (!src) return null;
    return { id: src.id, node: src, title: src.title || info(src).dn || src.type };
  }

  function openSheet(id) {
    const n = S.nodes.get(id);
    if (!n) return;
    selectNode(id);
    const inf = info(n);
    $("#shName").textContent = n.title || nodeZh(n.type) || inf.dn || n.type;
    $("#shType").textContent = n.type + (n.mode === 2 ? " · 静音" : n.mode === 4 ? " · 旁路" : "");

    const modes = $("#shModes");
    modes.innerHTML = "";
    [["normal", "正常"], ["mute", "静音"], ["bypass", "旁路"]].forEach(([k, label]) => {
      const b = document.createElement("button");
      b.className = "mode-btn" + ((n.mode === (k === "mute" ? 2 : k === "bypass" ? 4 : 0)) ? " on" : "");
      b.textContent = label;
      b.onclick = () => {
        n.mode = k === "mute" ? 2 : k === "bypass" ? 4 : 0;
        S.dirty = true;
        render();
        updateTitle();
        openSheet(id);
      };
      modes.appendChild(b);
    });

    const body = $("#sheetBody");
    body.innerHTML = "";
    const vals = values(n);

    if (n.type === "MarkdownNote" || n.type === "Note") {
      const t = document.createElement("textarea");
      t.value = (n.widgets_values || [])[0] || "";
      t.style.minHeight = "180px";
      t.onchange = () => {
        n.widgets_values = [t.value];
        S.dirty = true;
        updateNodePreview(id);
        updateTitle();
      };
      body.appendChild(field("文本", t));
    } else {
      const ws = MUConv.widgetSpecs(inf);
      let linkedCount = 0;
      ws.forEach((spec) => {
        const name = spec[0], st = spec[1], opts = spec[2] || {};
        if (isLinked(n, name)) {
          linkedCount++;
          body.appendChild(linkedField(id, n, name, opts));
          return;
        }
        const ctl = widgetControl(n, inf, name, st, opts, vals[name], false);
        if (!ctl) return;
        body.appendChild(field(name, ctl, opts.control_after_generate ? "可随机" : ""));
      });
      if (!ws.length) {
        const p = document.createElement("div");
        p.className = "empty";
        p.textContent = "这个节点没有可调的参数，它的输入全在连线上。";
        body.appendChild(p);
      } else if (linkedCount === ws.length) {
        const p = document.createElement("div");
        p.className = "q-item";
        p.style.marginBottom = "12px";
        p.innerHTML = '<div class="t" style="font-size:12.5px">参数都被上游接走了</div>' +
          '<div class="m">这个节点的 ' + ws.length + " 个参数全部由连线提供。" +
          "点「改成本机值」会断开对应连线，之后就能直接改。</div>";
        body.appendChild(p);
      }

      // dynamic sockets: the phone equivalent of the desktop "+" button
      autogrowInputs(inf).forEach((ag) => {
        const slots = autogrowSlots(n, ag);
        const h = document.createElement("div");
        h.className = "group-h";
        h.textContent = (zhLabel(ag.name) || ag.name) + " · 动态插槽";
        body.appendChild(h);

        const card = document.createElement("div");
        card.className = "q-item";
        card.innerHTML = '<div class="m">已开 <b style="color:#cbd3e2">' + slots.length +
          "</b> 个，范围 " + ag.min + "–" + ag.max +
          (slots.length ? "<br>" + esc(slots.map((s) => s.name).join("、")) : "<br>还没有开") + "</div>";
        body.appendChild(card);

        const bar = document.createElement("div");
        bar.className = "btn-row";
        const add = document.createElement("button");
        add.className = "btn small";
        add.style.flex = "1 1 0";
        add.textContent = "＋ 添加一个";
        add.disabled = slots.length >= ag.max;
        add.onclick = () => addAutogrowSlot(n, ag);
        const rm = document.createElement("button");
        rm.className = "btn small";
        rm.style.flex = "1 1 0";
        rm.textContent = "－ 去掉最后一个";
        rm.disabled = slots.length <= ag.min;
        rm.onclick = () => removeAutogrowSlot(n, ag);
        bar.appendChild(add);
        bar.appendChild(rm);
        body.appendChild(bar);
      });
    }

    // every input, with a way to wire it that does not need a precise drag.
    // Folded away by default so the sheet leads with values; opened when the
    // node has no values at all and wiring is the only thing to do here.
    if (n.inputs.length) {
      const det = document.createElement("details");
      det.className = "wirebox";
      if (!MUConv.widgetSpecs(inf).length) det.open = true;
      const sum = document.createElement("summary");
      sum.textContent = "接线（" + n.inputs.length + " 个输入）";
      det.appendChild(sum);
      n.inputs.forEach((inp, idx) => {
        const linked = inp.link != null;
        const row = document.createElement("div");
        row.className = "field";
        row.style.marginBottom = "8px";
        row.innerHTML = '<label><span class="nm">' + esc(inp.name) + "</span>" +
          '<span class="chip off">' + esc(inp.type || "*") + "</span>" +
          (linked ? '<span class="chip">已接线</span>' : "") + "</label>";
        const act = document.createElement("button");
        act.className = "btn small";
        act.textContent = linked ? "断开" : "选择来源…";
        act.onclick = () => {
          if (linked) { disconnect(id, idx); openSheet(id); }
          else pickSource(id, idx);
        };
        row.appendChild(act);
        if (linked) {
          const src = linkSource(n, inp.name);
          if (src) {
            const go = document.createElement("button");
            go.className = "btn small";
            go.style.marginTop = "6px";
            go.textContent = "跳到 #" + src.id + " " + src.title;
            go.onclick = () => {
              closeSheet();
              focusNode(src.id);
              openSheet(src.id);
            };
            row.appendChild(go);
          }
        }
        det.appendChild(row);
      });
      body.appendChild(det);
    }

    // upload for image loaders
    const imgName = MUConv.widgetSpecs(inf).map((x) => x[0]).find((x) => x === "image" || x === "image_file");
    if (imgName) {
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = "📷 从相册选择图片";
      b.onclick = () => pickImage(async (name) => {
        await refreshTypeOptions(n.type);
        MUConv.setValue(n, inf, imgName, name);
        S.dirty = true;
        updateNodePreview(id);
        updateTitle();
        toast("已设为 " + name);
        openSheet(id);
      });
      body.appendChild(b);
    }

    if (cropKeys(n) && upstreamImage(n)) {
      const b = document.createElement("button");
      b.className = "btn";
      b.style.marginTop = "8px";
      b.textContent = "🖼 可视化框选区域";
      b.onclick = () => openCropPicker(n);
      body.appendChild(b);
    }

    const actions = document.createElement("div");
    actions.className = "btn-row";
    actions.style.marginTop = "12px";
    const mk = (label, cls, fn) => {
      const b2 = document.createElement("button");
      b2.className = "btn small" + (cls ? " " + cls : "");
      b2.style.flex = "1 1 0";
      b2.textContent = label;
      b2.onclick = fn;
      actions.appendChild(b2);
    };
    mk("复制", "", () => duplicateNode(id));
    mk("重置", "", () => resetNode(id));
    mk("删除", "danger", () => {
      if (confirm("删除节点 #" + id + "？")) deleteNode(id);
    });
    body.appendChild(actions);

    const wasOpen = $("#sheet").classList.contains("open");
    $("#sheet").classList.add("open");
    $("#sheet").setAttribute("aria-hidden", "false");
    body.scrollTop = 0;
    if (!wasOpen) pushOverlay("sheet", rawCloseSheet);
  }

  /** A parameter whose value comes from a wire: no greyed-out control, just
   *  where it comes from and one action that turns it back into a local value. */
  function linkedField(id, n, name, opts) {
    const f = document.createElement("div");
    f.className = "field";
    const src = linkSource(n, name);
    const zh = zhLabel(name);
    f.innerHTML = '<label><span class="nm">' + esc(zh || name) + "</span>" +
      (zh ? '<span class="raw">' + esc(name) + "</span>" : "") +
      '<span class="chip">已接线</span>' +
      (src ? '<span class="chip off">#' + src.id + " " + esc(src.title) + "</span>" : "") +
      "</label>";

    const bar = document.createElement("div");
    bar.className = "btn-row";

    const own = document.createElement("button");
    own.className = "btn small";
    own.textContent = "改成本机值";
    own.onclick = () => {
      const idx = n.inputs.findIndex((x) => x.name === name);
      if (idx >= 0) disconnect(id, idx);
      openSheet(id);
      toast("已断开与上游的连接");
    };
    bar.appendChild(own);

    if (src) {
      const go = document.createElement("button");
      go.className = "btn small";
      go.textContent = "去改上游";
      go.onclick = () => { closeSheet(); focusNode(src.id); openSheet(src.id); };
      bar.appendChild(go);
    }
    f.appendChild(bar);
    return f;
  }

  function field(label, control, chip) {
    const f = document.createElement("div");
    f.className = "field";
    const l = document.createElement("label");
    const zh = zhLabel(label);
    l.innerHTML = '<span class="nm">' + esc(zh || label) + "</span>" +
      (zh ? '<span class="raw">' + esc(label) + "</span>" : "") +
      (chip ? '<span class="chip">' + esc(chip) + "</span>" : "");
    f.appendChild(l);
    f.appendChild(control);
    return f;
  }

  function widgetControl(n, inf, name, st, opts, cur, linked) {
    const typ = Array.isArray(st[0]) ? "COMBO" : st[0];
    const isCombo = typ === "COMBO" || typ === "COMFY_DYNAMICCOMBO_V3";
    let el;

    if (typ === "BOOLEAN") {
      el = document.createElement("label");
      el.className = "switch";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!cur;
      const tr = document.createElement("span");
      tr.className = "track";
      el.appendChild(tr);
      el.appendChild(cb);
      cb.onchange = () => commit(cb.checked);
      if (linked) cb.disabled = true;
      return wrapControl(el, opts, n, inf, name);
    }

    if (MUConv.isColorType(typ)) {
      const row = document.createElement("div");
      row.className = "range-row";
      const raw = typeof cur === "string" ? cur : "";
      let hex = /^#[0-9a-f]{6}$/i.test(raw) ? raw
        : /^#[0-9a-f]{3}$/i.test(raw)
          ? "#" + raw[1] + raw[1] + raw[2] + raw[2] + raw[3] + raw[3]
          : "#000000";
      const picker = document.createElement("input");
      picker.type = "color";
      picker.value = hex;
      picker.style.cssText = "width:56px;height:42px;padding:2px;border-radius:10px;border:1px solid #29313f;background:#0d1117;flex:0 0 auto";
      const text = document.createElement("input");
      text.type = "text";
      text.value = raw;
      picker.oninput = () => { text.value = picker.value; commit(picker.value); };
      text.onchange = () => {
        commit(text.value);
        if (/^#[0-9a-f]{6}$/i.test(text.value)) picker.value = text.value;
      };
      if (linked) { picker.disabled = true; text.disabled = true; }
      row.appendChild(picker);
      row.appendChild(text);
      return wrapControl(row, opts, n, inf, name);
    }

    if (isCombo) {      el = document.createElement("select");
      const options = opts.options || [];
      options.forEach((o) => {
        const op = document.createElement("option");
        op.value = String(o);
        op.textContent = String(o);
        el.appendChild(op);
      });
      if (!options.length) {
        const op = document.createElement("option");
        op.value = String(cur == null ? "" : cur);
        op.textContent = String(cur == null ? "（加载中…）" : cur);
        el.appendChild(op);
        loadFullOptions(n.type, name).then((vals2) => {
          if (!vals2 || !vals2.length) return;
          el.innerHTML = "";
          vals2.forEach((o) => {
            const op2 = document.createElement("option");
            op2.value = String(o);
            op2.textContent = String(o);
            el.appendChild(op2);
          });
          el.value = String(cur);
        });
      }
      el.value = String(cur == null ? "" : cur);
      el.onchange = () => commit(el.value);
      if (linked) el.disabled = true;
      return wrapControl(el, opts, n, inf, name);
    }

    if ((typ === "INT" || typ === "FLOAT") && typeof opts.min === "number" &&
        typeof opts.max === "number" && opts.max - opts.min <= 100000 && opts.max - opts.min > 0) {
      const row = document.createElement("div");
      row.className = "range-row";
      const range = document.createElement("input");
      range.type = "range";
      range.min = opts.min; range.max = opts.max;
      range.step = opts.step || (typ === "INT" ? 1 : 0.01);
      range.value = cur != null ? cur : opts.default || opts.min;
      const num = document.createElement("input");
      num.type = "number";
      num.min = opts.min; num.max = opts.max;
      num.step = range.step;
      num.value = range.value;
      range.oninput = () => { num.value = range.value; commit(typ === "INT" ? parseInt(range.value, 10) : parseFloat(range.value)); };
      num.onchange = () => {
        const v = typ === "INT" ? parseInt(num.value, 10) : parseFloat(num.value);
        if (!isNaN(v)) { range.value = v; commit(v); }
      };
      if (linked) { range.disabled = true; num.disabled = true; }
      row.appendChild(range); row.appendChild(num);
      return wrapControl(row, opts, n, inf, name);
    }

    if (typ === "INT" || typ === "FLOAT") {
      el = document.createElement("input");
      el.type = "number";
      el.inputMode = "decimal";
      if (typeof opts.min === "number") el.min = opts.min;
      if (typeof opts.max === "number") el.max = opts.max;
      el.step = opts.step || (typ === "INT" ? 1 : 0.01);
      el.value = cur != null ? cur : "";
      el.onchange = () => {
        const v = typ === "INT" ? parseInt(el.value, 10) : parseFloat(el.value);
        if (!isNaN(v)) commit(v);
      };
      if (linked) el.disabled = true;
      return wrapControl(el, opts, n, inf, name);
    }

    // strings
    const long = opts.multiline || /prompt|text|expression|sigmas/i.test(name) ||
      (typeof cur === "string" && cur.length > 48);
    el = document.createElement(long ? "textarea" : "input");
    if (!long) el.type = "text";
    el.value = cur == null ? "" : String(cur);
    el.onchange = () => commit(el.value);
    if (linked) el.disabled = true;
    const box = wrapControl(el, opts, n, inf, name);
    // long free text is where fragments get composed
    if (long && !linked) addPromptTools(box, el, commit);
    return box;

    function commit(v) {
      MUConv.setValue(n, inf, name, v);
      S.dirty = true;
      updateNodePreview(n.id);
      updateTitle();
    }
  }

  function wrapControl(el, opts, n, inf, name) {
    const box = document.createElement("div");
    box.appendChild(el);
    if (opts && opts.control_after_generate && n && inf) {
      const sel = document.createElement("select");
      sel.style.marginTop = "6px";
      [["fixed", "固定种子"], ["randomize", "每次都随机"], ["increment", "每次 +1"]].forEach(([v, t]) => {
        const o = document.createElement("option");
        o.value = v; o.textContent = t;
        sel.appendChild(o);
      });
      sel.value = MUConv.getValues(n, inf).control_after_generate || "fixed";
      sel.onchange = () => {
        MUConv.setValue(n, inf, "control_after_generate", sel.value);
        S.dirty = true;
        updateTitle();
      };
      box.appendChild(sel);
    }
    return box;
  }

  async function loadFullOptions(type, widget) {
    try {
      if (!S.oiFull[type]) {
        const r = await fetch(api("object_info/" + encodeURIComponent(type)));
        S.oiFull[type] = await r.json();
      }
      const info2 = S.oiFull[type][type];
      const spec = (info2.input.required && info2.input.required[widget]) ||
                   (info2.input.optional && info2.input.optional[widget]);
      if (!spec) return null;
      const o = spec[1] || {};
      if (Array.isArray(spec[0])) return spec[0];
      return o.options || null;
    } catch (e) {
      return null;
    }
  }

  /** Pick a compatible upstream output by list instead of by dragging a 1px dot
   *  at low zoom - the only workable way to wire a graph on a phone screen. */
  /** Dynamic-slot inputs (COMFY_AUTOGROW_V3): the node gains sockets such as
   *  ref_image_0/1/2 on demand. On the desktop canvas that is a "+" button; on a
   *  phone the same thing has to be a list with add/remove. */
  function autogrowInputs(inf) {
    const out = [];
    ["required", "optional"].forEach((sec) => {
      const d = (inf.in && inf.in[sec]) || {};
      Object.keys(d).forEach((name) => {
        const spec = d[name];
        if (!Array.isArray(spec) || spec[0] !== "COMFY_AUTOGROW_V3") return;
        const t = (spec[1] && spec[1].template) || {};
        out.push({
          name, template: t,
          min: t.min == null ? 1 : t.min,
          max: t.max == null ? 10 : t.max,
        });
      });
    });
    return out;
  }

  /* Slots live under the parent input's name: the n-th reference image is
   * "ref_images.ref_image_0", not "ref_image_0". */
  function autogrowSlots(n, spec) {
    const t = spec.template || {};
    const names = Array.isArray(t.names) ? t.names : null;
    const prefix = t.prefix || "";
    const head = spec.name + ".";
    return n.inputs.filter((inp) => {
      if (inp.name.indexOf(head) !== 0) return false;
      const rest = inp.name.slice(head.length);
      if (names) return names.indexOf(rest) >= 0;
      if (prefix && rest.indexOf(prefix) !== 0) return false;
      return /^\d+$/.test(rest.slice(prefix.length));
    });
  }

  function addAutogrowSlot(n, spec) {
    const slots = autogrowSlots(n, spec);
    if (slots.length >= spec.max) { toast("最多 " + spec.max + " 个"); return; }
    const t = spec.template || {};
    const head = spec.name + ".";
    const name = Array.isArray(t.names)
      ? head + t.names[slots.length]
      : head + (t.prefix || "") + slots.length;
    if (!name || name === head) { toast("已达上限"); return; }
    const tpl = t.input || {};
    const first = Object.values(tpl.required || {})[0] ||
                  Object.values(tpl.optional || {})[0] || ["*", {}];
    n.inputs.push({ name, type: Array.isArray(first[0]) ? "COMBO" : first[0], link: null });
    S.dirty = true;
    render();
    openSheet(n.id);
    updateTitle();
    toast("已添加 " + name);
  }

  function removeAutogrowSlot(n, spec) {
    const slots = autogrowSlots(n, spec);
    if (!slots.length) return;
    if (slots.length <= spec.min) { toast("最少保留 " + spec.min + " 个"); return; }
    const last = slots[slots.length - 1];
    if (last.link != null) { toast("最后一个还连着线，先在「接线」里断开"); return; }
    const idx = n.inputs.indexOf(last);
    n.inputs.splice(idx, 1);
    // links address inputs by index, so everything after the hole moves down
    S.links.forEach((l) => {
      if (l.target === n.id && l.tslot > idx) l.tslot -= 1;
    });
    S.dirty = true;
    render();
    openSheet(n.id);
    updateTitle();
    toast("已去掉 " + last.name);
  }

  function pickSource(inNode, inSlot) {
    const dst = S.nodes.get(inNode);
    const inType = (dst.inputs[inSlot] && dst.inputs[inSlot].type) || "*";
    const cands = [];
    S.nodes.forEach((n) => {
      if (n.id === inNode) return;
      const dist = Math.abs(n.pos[0] - dst.pos[0]) + Math.abs(n.pos[1] - dst.pos[1]);
      (n.outputs || []).forEach((o, j) => {
        if (!MUConv.typesCompatible(o.type, inType)) return;
        cands.push({
          id: n.id, slot: j, name: o.name, type: o.type, dist,
          title: n.title || info(n).dn || n.type,
        });
      });
    });
    cands.sort((a, b) => (a.dist - b.dist) || (a.id - b.id));

    openPanelRaw("连接到「" + (dst.inputs[inSlot].name || "输入") + "」", "", (body) => {
      if (!cands.length) {
        body.innerHTML = '<div class="empty">没有类型兼容的输出（需要 ' + esc(inType) + "）</div>";
        return;
      }
      const s = document.createElement("input");
      s.className = "search";
      s.placeholder = "搜索节点…";
      body.appendChild(s);
      const list = document.createElement("div");
      body.appendChild(list);
      const draw = () => {
        const q = s.value.trim().toLowerCase();
        list.innerHTML = "";
        cands.filter((c) => !q || (c.title + " " + c.type + " " + c.name).toLowerCase().includes(q))
          .slice(0, 80)
          .forEach((c) => {
            const it = document.createElement("button");
            it.className = "wf-item";
            it.innerHTML = '<div class="t">#' + c.id + " " + esc(c.title) + "</div>" +
              '<div class="m">' + esc(c.name === c.type ? c.type : c.name + " · " + c.type) + "</div>";
            it.onclick = () => {
              connect(c.id, c.slot, inNode, inSlot);
              closePanel();
              openSheet(inNode);
              toast("已接线");
            };
            list.appendChild(it);
          });
        if (!list.children.length) list.innerHTML = '<div class="empty">没有匹配</div>';
      };
      s.oninput = draw;
      draw();
    });
  }

  /* ---------------------------------------------------------- back navigation
   * A phone's back gesture closes the browser tab unless something is on the
   * history stack. Every overlay pushes a state, so back peels one layer at a
   * time: full-screen panel → bottom sheet → canvas. Only at the canvas does
   * back leave the page. */
  const overlayStack = [];
  let popping = false;
  let guardArmed = false;
  let leaving = false;

  /* One permanent entry above the page's own, so a back press at the canvas
   * lands on us instead of unloading the document. Without it there is nothing
   * to intercept — the browser has already navigated by the time we hear about
   * it. */
  function armBackGuard() {
    if (guardArmed || leaving) return;
    try {
      history.pushState({ muiGuard: 1 }, "");
      guardArmed = true;
    } catch (_) {}
  }

  function pushOverlay(kind, closer) {
    overlayStack.push({ kind, closer });
    try { history.pushState({ muiOverlay: overlayStack.length }, ""); } catch (_) {}
  }

  /** Close an overlay by kind. `consumeHistory` is false when the close came
   *  from popstate itself (the entry is already gone). */
  function popOverlay(kind) {
    let idx = -1;
    for (let i = overlayStack.length - 1; i >= 0; i--) {
      if (overlayStack[i].kind === kind) { idx = i; break; }
    }
    if (idx < 0) return false;
    const entry = overlayStack.splice(idx, 1)[0];
    entry.closer();
    if (idx === overlayStack.length) {   // it was the topmost
      popping = true;
      try { history.back(); } catch (_) { popping = false; }
    }
    return true;
  }

  function topOverlayKind() {
    return overlayStack.length ? overlayStack[overlayStack.length - 1].kind : null;
  }

  window.addEventListener("popstate", () => {
    if (popping) { popping = false; return; }
    if (leaving) return;
    if (overlayStack.length) { overlayStack.pop().closer(); return; }

    /* At the canvas: the guard entry was just consumed, so ask before the next
     * back press takes the page away. */
    guardArmed = false;
    const go = window.confirm("离开手机端界面？\n\n点「确定」退出，点「取消」留在画布。");
    if (go) {
      leaving = true;
      try { history.back(); } catch (_) {}
      /* If there was nothing behind this page the back does nothing; re-arm so
       * the guard is not silently lost. */
      setTimeout(() => { leaving = false; armBackGuard(); }, 1500);
    } else {
      armBackGuard();
    }
  });

  function closeSheet() {
    if (popOverlay("sheet")) return;
    rawCloseSheet();
  }

  function rawCloseSheet() {
    $("#sheet").classList.remove("open");
    $("#sheet").setAttribute("aria-hidden", "true");
  }

  function deleteNode(id) {
    S.nodes.delete(id);
    for (const l of Array.from(S.links.values())) {
      if (l.origin === id || l.target === id) S.links.delete(l.id);
    }
    S.dirty = true;
    S.sel = null;
    closeSheet();
    render();
    updateTitle();
  }

  /** Copy a node beside itself. Built field by field rather than JSON-cloned,
   *  because the live object carries a DOM reference that cannot be serialised. */
  function duplicateNode(id) {
    const n = S.nodes.get(id);
    if (!n) return;
    let nid = 1;
    S.nodes.forEach((_, k) => { nid = Math.max(nid, k + 1); });
    const copy = {
      id: nid,
      type: n.type,
      pos: [n.pos[0] + 36, n.pos[1] + 36],
      size: [n.size[0], n.size[1]],
      flags: {},
      order: n.order || 0,
      mode: n.mode || 0,
      title: n.title,
      properties: JSON.parse(JSON.stringify(n.properties || {})),
      widgets_values: JSON.parse(JSON.stringify(n.widgets_values || [])),
      widgets_values_named: JSON.parse(JSON.stringify(n.widgets_values_named || {})),
      inputs: (n.inputs || []).map((x) => Object.assign({}, x, { link: null })),
      outputs: (n.outputs || []).map((o) => Object.assign({}, o, { links: null })),
    };
    S.nodes.set(nid, copy);
    if (S.doc) S.doc.last_node_id = Math.max(S.doc.last_node_id || 0, nid);
    S.dirty = true;
    render();
    updateTitle();
    focusNode(nid);
    openSheet(nid);
    toast("已复制为 #" + nid);
  }

  function resetNode(id) {
    const n = S.nodes.get(id);
    if (!n) return;
    const inf = info(n);
    MUConv.widgetSpecs(inf).forEach(([name, spec, opts]) => {
      let d = opts.default;
      if (d === undefined) {
        if (Array.isArray(opts.options) && opts.options.length) d = opts.options[0];
        else if (spec[0] === "INT" || spec[0] === "FLOAT") d = 0;
        else if (spec[0] === "BOOLEAN") d = false;
        else d = "";
      }
      MUConv.setValue(n, inf, name, d);
    });
    S.dirty = true;
    render();
    openSheet(id);
    toast("已恢复默认值");
  }

  /* ================================================================ run / ws */

  function setRunState(running, pct, label) {
    const btn = $("#btnRun");
    btn.innerHTML = running
      ? '<svg viewBox="0 0 24 24" class="ic-stop"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>'
      : '<svg viewBox="0 0 24 24" class="ic-play"><path d="M8 5.5v13l11-6.5z"/></svg>';
    const bar = $("#progress");
    bar.classList.toggle("on", !!running);
    bar.querySelector("i").style.width = (pct || 0) + "%";
    bar.querySelector("b").textContent = label || "";
  }

  async function loadObjectInfo(attempts = 4) {
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetch(rel("api/object_info" + (i ? "?refresh=1" : "")));
        const oi = await r.json();
        if (oi && oi.error) throw new Error(oi.error);
        const n = oi ? Object.keys(oi).length : 0;
        // a half-loaded table is worse than none: it makes every node look
        // uninstalled, which reads as "your workflow is broken"
        if (n < 50) throw new Error("节点表不完整（" + n + " 项）");
        S.oi = oi;
        S.oiError = "";
        return true;
      } catch (e) {
        S.oiError = e.message;
        if (i === attempts - 1) return false;
        await new Promise((res) => setTimeout(res, 1200 * (i + 1)));
      }
    }
    return false;
  }

  function hasTable() {
    return S.oi && Object.keys(S.oi).length >= 50;
  }

  /* Only file-backed combo lists are worth validating. A COMFY_DYNAMICCOMBO or a
   * plain enum ("auto", "false", "scale by multiplier") resolves its options at
   * run time, so the static list from /object_info does not contain the legal
   * value and checking it would block perfectly good workflows. */
  const FILE_EXT = /\.(safetensors|sft|ckpt|pt|pt2|pth|bin|gguf|onnx|pkl|png|jpe?g|webp|gif|bmp|tiff?|mp4|webm|mov|mkv|avi|wav|mp3|flac|ogg|m4a)$/i;

  function isFileList(list) {
    return Array.isArray(list) && list.some((o) => FILE_EXT.test(String(o)));
  }

  /* A combo value copied from another machine may carry a folder prefix this
   * install no longer has ("Qwen\qwen_x.safetensors" vs "qwen_x.safetensors").
   * Matching on the bare filename fixes that without touching the file on disk,
   * and is only applied when exactly one candidate matches. */
  function repairComboPaths() {
    const fixed = [];
    S.nodes.forEach((n) => {
      const inf = info(n);
      const vals = values(n);
      MUConv.widgetSpecs(inf).forEach(([name, spec, opts]) => {
        const list = Array.isArray(spec[0]) ? spec[0] : (opts.options || null);
        if (!isFileList(list)) return;
        if (isLinked(n, name)) return;
        const v = vals[name];
        if (v == null || list.indexOf(v) >= 0) return;
        const base = String(v).split(/[\\/]/).pop().toLowerCase();
        const hit = list.filter((o) => String(o).split(/[\\/]/).pop().toLowerCase() === base);
        if (hit.length === 1) {
          MUConv.setValue(n, inf, name, hit[0]);
          fixed.push({ id: n.id, widget: name, from: v, to: hit[0] });
        }
      });
    });
    return fixed;
  }

  /** Everything that would make /prompt reject this graph, gathered before it is
   *  sent, so the message names the missing thing instead of dumping 30 lines. */
  function preflight() {
    const out = { missingTypes: new Map(), badValues: [], missingImages: [] };
    S.nodes.forEach((n) => {
      const mode = n.mode | 0;
      if (mode === 2 || mode === 4) return;
      if (MUConv.FRONTEND_ONLY[n.type]) return;
      const inf = S.oi[n.type];
      if (!inf) {
        if (!out.missingTypes.has(n.type)) out.missingTypes.set(n.type, []);
        out.missingTypes.get(n.type).push(n.id);
        return;
      }
      const vals = values(n);
      MUConv.widgetSpecs(inf).forEach(([name, spec, opts]) => {
        const list = Array.isArray(spec[0]) ? spec[0] : (opts.options || null);
        if (!isFileList(list)) return;
        if (isLinked(n, name)) return;
        const v = vals[name];
        if (v == null || list.indexOf(v) >= 0) return;
        const entry = { id: n.id, type: n.type, widget: name, value: String(v) };
        if (name === "image" || name === "image_file") out.missingImages.push(entry);
        else out.badValues.push(entry);
      });
    });
    return out;
  }

  function showRunProblems(pf, convErrors) {
    const groups = new Map();
    (convErrors || []).forEach((msg) => {
      const m = /^#(\d+)\s+([^：]+)：(.*)$/.exec(msg);
      if (m) {
        const key = m[2].trim() + "：" + m[3];
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m[1]);
      } else {
        if (!groups.has(msg)) groups.set(msg, []);
      }
    });

    openPanelRaw("无法运行", "", (body) => {
      const add = (title, lines) => {
        if (!lines.length) return;
        const h = document.createElement("div");
        h.className = "group-h";
        h.textContent = title;
        body.appendChild(h);
        lines.forEach((t) => {
          const d = document.createElement("div");
          d.className = "q-item";
          d.innerHTML = t;
          body.appendChild(d);
        });
      };

      add("缺少节点类型（需要装对应的节点包）", Array.from(pf.missingTypes.entries())
        .map(([t, ids]) => "<b>" + esc(t) + "</b><br>节点 " + ids.map((i) => "#" + i).join("、")));

      add("模型路径对不上（文件不在，或子目录变了）", pf.badValues.slice(0, 8)
        .map((b) => "<b>#" + b.id + " " + esc(b.type) + "</b><br>" + esc(b.widget) +
          " = <code>" + esc(b.value) + "</code>"));

      add("缺输入图片（去相册选一张）", pf.missingImages.slice(0, 6)
        .map((b) => "<b>#" + b.id + " " + esc(b.type) + "</b><br>需要 " + esc(b.value)));

      add("其他", Array.from(groups.entries())
        .map(([k, ids]) => "缺少输入/接线：" + esc(k) + (ids.length ? "（节点 " + ids.map((i) => "#" + i).join("、") + "）" : ""))
        .slice(0, 10));

      if (!pf.missingTypes.size && !pf.badValues.length && !pf.missingImages.length && !groups.size) {
        add("提示", ["没有发现明确原因，可以把下面的原始报错发给开发者"]);
      }
    });
  }

  async function runOrStop() {
    if (S.running) {
      try {
        await fetch(api("interrupt"), { method: "POST" });
        toast("已发送中断");
      } catch (e) { toast("中断失败：" + e.message, true); }
      return;
    }
    if (!S.doc) { toast("先打开一个工作流", true); return; }

    if (!hasTable()) {
      setSub("节点表未加载，正在重试…");
      const ok = await loadObjectInfo(4);
      if (!ok) {
        showProblems("节点表没加载出来", [
          "ComfyUI 的节点清单没有取到：" + (S.oiError || "未知原因"),
          "这通常发生在 ComfyUI 正在启动或重启的时候。",
          "等它启动完，回到顶部菜单 → 设置 → 重新读取节点信息。",
        ]);
        return;
      }
      render();
      setSub(Object.keys(S.oi).length + " 种节点已就绪");
    }

    const fixed = repairComboPaths();
    if (fixed.length) {
      toast("已按文件名修正 " + fixed.length + " 处模型路径");
      render();
    }

    const pf = preflight();

    /* A file uploaded after this page loaded is missing from the combo snapshot
     * but present on disk, and ComfyUI will accept it. Verify against the file
     * itself before telling someone their image is missing. */
    if (pf.missingImages.length) {
      const stillMissing = [];
      for (const m of pf.missingImages) {
        if (!(await inputExists(m.value, "input"))) stillMissing.push(m);
      }
      pf.missingImages = stillMissing;
    }

    const conv = MUConv.convert(S.doc, S.oi, { randomize: true });
    if (pf.missingTypes.size || pf.badValues.length || pf.missingImages.length || conv.errors.length) {
      showRunProblems(pf, conv.errors);
      return;
    }
    if (conv.warnings.length) toast(conv.warnings[0]);

    $("#btnRun").disabled = true;
    S.donePrompt = null;
    try {
      const res = await fetch(api("prompt"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: conv.prompt, client_id: S.clientId }),
      });
      const j = await res.json();
      if (j.error) {
        showProblems("ComfyUI 拒绝执行", [j.error.message || String(j.error)].concat(
          j.error.details ? [j.error.details] : []));
        return;
      }
      if (j.node_errors && Object.keys(j.node_errors).length) {
        const msgs = [];
        for (const k of Object.keys(j.node_errors)) {
          const ne = j.node_errors[k];
          (ne.errors || []).forEach((er) => msgs.push("#" + k + " " + (er.message || "") + (er.details ? " — " + er.details : "")));
        }
        showProblems("节点校验失败", msgs);
        return;
      }
      S.running = j.prompt_id;
      setRunState(true, 0, "排队中");
      setSub("已提交 #" + (j.number || ""));
      hideHint();
      watchRun(j.prompt_id);
    } catch (e) {
      showProblems("提交失败", [e.message]);
    } finally {
      $("#btnRun").disabled = false;
    }
  }

  function showProblems(title, list) {
    openPanelRaw(title, "", (body) => {
      const ul = document.createElement("div");
      list.forEach((t) => {
        const d = document.createElement("div");
        d.className = "q-item";
        d.textContent = t;
        ul.appendChild(d);
      });
      body.appendChild(ul);
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = "知道了";
      b.onclick = closePanel;
      body.appendChild(b);
    });
  }

  function connectWS() {
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    let url = proto + location.host + api("ws?clientId=" + S.clientId);
    try { S.ws = new WebSocket(url); } catch (e) { return; }
    S.ws.onopen = () => { S.wsRetry = 0; };
    S.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      handleWS(msg);
    };
    S.ws.onclose = () => {
      S.wsRetry = Math.min(S.wsRetry + 1, 6);
      const wait = Math.min(30000, 800 * Math.pow(1.7, S.wsRetry));
      setTimeout(connectWS, wait);
    };
  }

  function handleWS(msg) {
    const t = msg.type, d = msg.data || {};
    if (t === "execution_start") {
      S.running = d.prompt_id || S.running;
      setRunState(true, 2, "开始");
    } else if (t === "executing") {
      if (d.node == null) {
        finishRun(d.prompt_id);
      } else {
        setRunState(true, undefined, "节点 #" + d.node);
        const n = S.nodes.get(d.node);
        if (n) setSub("正在执行 " + (n.title || n.type));
      }
    } else if (t === "progress") {
      const pct = d.max ? Math.round((d.value / d.max) * 100) : 0;
      setRunState(true, pct, d.value + "/" + d.max);
    } else if (t === "executed") {
      // output lands in history; nothing to do per node
    } else if (t === "execution_error") {
      S.running = null;
      clearInterval(runTimer);
      setRunState(false, 0, "");
      showProblems("执行出错", [
        (d.node_type ? d.node_type + " #" + d.node_id + "：" : "") + (d.exception_message || "未知错误"),
        d.exception_type || "",
      ].filter(Boolean));
    } else if (t === "execution_interrupted") {
      S.running = null;
      clearInterval(runTimer);
      setRunState(false, 0, "");
      toast("已中断");
    } else if (t === "status") {
      const q = d.status && d.status.exec_info ? d.status.exec_info.queue_remaining : 0;
      if (!S.running && q > 0) setSub("队列中还有 " + q + " 个任务");
    }
  }

  /* The WebSocket is the fast path for progress, but a phone that locks its
   * screen or loses the tab can miss the final "executing: null". Polling
   * /history for our own prompt id is the backstop that keeps the run state
   * from sticking on "running" forever. */
  let runTimer = 0;
  function watchRun(pid) {
    clearInterval(runTimer);
    runTimer = setInterval(async () => {
      if (!S.running || S.running !== pid) { clearInterval(runTimer); return; }
      try {
        const h = await (await fetch(api("history/" + pid))).json();
        if (h && h[pid]) { clearInterval(runTimer); finishRun(pid); }
      } catch (_) {}
    }, 4000);
  }

  async function finishRun(promptId) {
    const pid = promptId || S.running;
    if (!pid || S.donePrompt === pid) return;
    S.donePrompt = pid;
    clearInterval(runTimer);
    S.running = null;
    setRunState(false, 100, "");
    setTimeout(() => setRunState(false, 0, ""), 900);
    if (!pid) return;
    try {
      const h = await (await fetch(api("history/" + pid))).json();
      const entry = h[pid];
      const items = collectOutputs(entry);
      if (items.length) {
        setSub("完成：" + items.length + " 个输出");
        S.lastResult = items;
        openPanel("gallery");
      } else {
        setSub("完成（无输出）");
      }
    } catch (e) {
      setSub("完成");
    }
  }

  function collectOutputs(entry) {
    const out = [];
    if (!entry || !entry.outputs) return out;
    for (const nodeId of Object.keys(entry.outputs)) {
      const o = entry.outputs[nodeId];
      ["images", "gifs", "videos"].forEach((kind) => {
        (o[kind] || []).forEach((f) => {
          out.push({
            filename: f.filename, subfolder: f.subfolder || "",
            type: f.type || "output", kind,
          });
        });
      });
    }
    return out;
  }

  /** Clipboard on a plain-http LAN origin is not a secure context, so
   *  navigator.clipboard is usually unavailable - fall back to execCommand. */
  function copyText(text) {
    const done = () => toast("已复制：" + text);
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => fallback());
      return;
    }
    fallback();
    function fallback() {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;top:0;left:0;";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (_) {}
      document.body.removeChild(ta);
      toast(ok ? "已复制：" + text : text);
    }
  }

  /* ================================================================== panels */

  function openPanel(kind) {
    const render = PANELS[kind];
    if (!render) return;
    const def = render();
    openPanelRaw(def.title, def.action, def.body, def.actionFn);
  }

  function openPanelRaw(title, actionLabel, build, actionFn) {
    if (typeof actionLabel === "function") { actionFn = actionLabel; actionLabel = ""; }
    $("#panelTitle").textContent = title;
    const act = $("#panelAction");
    act.textContent = actionLabel || "";
    act.onclick = actionLabel ? actionFn : null;
    const body = $("#panelBody");
    body.innerHTML = "";
    build(body);
    const wasOpen = $("#panel").classList.contains("open");
    $("#panel").classList.add("open");
    $("#panel").setAttribute("aria-hidden", "false");
    if (!wasOpen) pushOverlay("panel", rawClosePanel);
  }

  function closePanel() {
    if (popOverlay("panel")) return;
    rawClosePanel();
  }

  function rawClosePanel() {
    $("#panel").classList.remove("open");
    $("#panel").setAttribute("aria-hidden", "true");
  }

  /* ============================================================ prompt library */
  /* Fragments are *composed*, not applied as whole templates: a tap inserts at
   * the caret of the field that was open, so "backlit" then "85mm" build up
   * instead of replacing each other. */

  let promptTarget = null;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  async function loadPrompts(force) {
    if (S.prompts && !force) return S.prompts;
    try {
      const r = await (await fetch(rel("api/prompts"))).json();
      S.prompts = { rev: r.rev || 0, items: r.items || [], file: r.file || "" };
    } catch (_) {
      S.prompts = S.prompts || { rev: 0, items: [], file: "" };
    }
    return S.prompts;
  }

  async function persistPrompts(data) {
    try {
      const res = await fetch(rel("api/prompts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rev: data.rev, items: data.items }),
      });
      if (res.status === 409) {
        const cur = await res.json();
        S.prompts = { rev: cur.rev, items: cur.items || [], file: (S.prompts || {}).file };
        toast("词库已被其他设备改过，已刷新，请重试", true);
        return false;
      }
      const out = await res.json();
      if (out.error) { toast(out.error, true); return false; }
      S.prompts = { rev: out.rev, items: out.items, file: (S.prompts || {}).file };
      return true;
    } catch (e) {
      toast("保存失败：" + e.message, true);
      return false;
    }
  }

  /** Insert at the caret of the text field the library was opened from. */
  function insertFragment(text) {
    const t = promptTarget;
    if (t && t.el && t.el.isConnected) {
      const el = t.el;
      const start = el.selectionStart == null ? el.value.length : el.selectionStart;
      const end = el.selectionEnd == null ? start : el.selectionEnd;
      const before = el.value.slice(0, start);
      const after = el.value.slice(end);
      /* Keep the result readable: "a portrait" + fragment needs a separator,
       * "a portrait, " does not, and "a portrait," needs only the space. */
      let sep = "";
      if (before) {
        if (/[,，;；]\s*$/.test(before)) sep = /\s$/.test(before) ? "" : " ";
        else if (/\s$/.test(before)) sep = "";
        else sep = ", ";
      }
      const ins = sep + text;
      el.value = before + ins + after;
      t.commit(el.value);
      el.focus();
      const pos = (before + ins).length;
      try { el.setSelectionRange(pos, pos); } catch (_) {}
      closePanel();
      toast("已插入片段");
      return;
    }
    // opened from the dock: nothing to insert into, so hand it to the clipboard
    const done = () => toast("已复制片段");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => toast("复制失败", true));
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (_) { toast("复制失败", true); }
    ta.remove();
  }

  async function saveFragment(text) {
    const t = String(text || "").trim();
    if (!t) { toast("这个字段是空的", true); return; }
    const data = await loadPrompts(true);
    const name = t.replace(/\s+/g, " ").slice(0, 18).replace(/\s\S*$/, "") || t.slice(0, 18);
    data.items.unshift({
      id: uid(), name, text: t, group: "未分组", tags: [], created: Date.now(), used: 0,
    });
    if (await persistPrompts(data)) toast("已存为片段「" + name + "」");
  }

  function addPromptTools(box, el, commit) {
    const row = document.createElement("div");
    row.className = "pg-tools";
    const ins = document.createElement("button");
    ins.className = "btn small";
    ins.textContent = "📚 插入片段";
    ins.onclick = () => { promptTarget = { el, commit }; openPanel("prompts"); };
    const save = document.createElement("button");
    save.className = "btn small ghost";
    save.textContent = "💾 存为片段";
    save.onclick = () => saveFragment(el.value);
    row.appendChild(ins);
    row.appendChild(save);
    box.appendChild(row);
  }

  function editFragment(item) {
    const isNew = !item;
    const draft = item
      ? Object.assign({}, item)
      : { id: uid(), name: "", text: "", group: "未分组", tags: [], created: Date.now(), used: 0 };

    // the build callback and the save callback run at different times, so the
    // inputs have to live in this scope rather than inside build()
    let nameIn = null;
    let groupIn = null;
    let textIn = null;

    openPanelRaw(isNew ? "新建片段" : "编辑片段", "保存", (b) => {
      const field = (label, value, multi, ph) => {
        const box = document.createElement("div");
        box.className = "field";
        const lab = document.createElement("label");
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = label;
        lab.appendChild(nm);
        box.appendChild(lab);
        const el = document.createElement(multi ? "textarea" : "input");
        if (!multi) el.type = "text";
        el.value = value || "";
        if (ph) el.placeholder = ph;
        box.appendChild(el);
        b.appendChild(box);
        return el;
      };
      const nameIn2 = field("名称", draft.name, false, "比如：午后逆光");
      const groupIn2 = field("分组", draft.group, false, "比如：光照 / 镜头 / 画质");
      const textIn2 = field("内容", draft.text, true, "要插入的提示词片段");
      nameIn = nameIn2;
      groupIn = groupIn2;
      textIn = textIn2;

      if (!isNew) {
        const del = document.createElement("button");
        del.className = "btn danger";
        del.style.marginTop = "14px";
        del.textContent = "删除这个片段";
        del.onclick = async () => {
          if (!confirm("删除「" + (draft.name || "未命名") + "」？")) return;
          const data = await loadPrompts(true);
          data.items = data.items.filter((x) => x.id !== draft.id);
          if (await persistPrompts(data)) { toast("已删除"); openPanel("prompts"); }
        };
        b.appendChild(del);
      }
    }, async () => {
      if (!textIn) return;
      draft.text = textIn.value;
      if (!draft.text.trim()) { toast("内容不能为空", true); return; }
      draft.name = (nameIn && nameIn.value.trim()) ||
        draft.text.replace(/\s+/g, " ").slice(0, 18) || "未命名";
      draft.group = (groupIn && groupIn.value.trim()) || "未分组";
      const data = await loadPrompts(true);
      const i = data.items.findIndex((x) => x.id === draft.id);
      if (i >= 0) data.items[i] = draft; else data.items.unshift(draft);
      if (await persistPrompts(data)) { toast("已保存"); openPanel("prompts"); }
    });
  }

  const PANELS = {
    prompts() {
      const body = (b) => {
        let q = "";
        let group = "全部";

        const search = document.createElement("input");
        search.className = "search";
        search.placeholder = "搜索片段 / 分组…";
        b.appendChild(search);

        const chips = document.createElement("div");
        chips.className = "pg-chips";
        b.appendChild(chips);

        const list = document.createElement("div");
        list.className = "pg-list";
        b.appendChild(list);

        const note = document.createElement("div");
        note.className = "empty";
        b.appendChild(note);

        const draw = async () => {
          const data = await loadPrompts(true);
          const items = data.items || [];
          const groups = ["全部"].concat([...new Set(items.map((x) => x.group || "未分组"))]);
          chips.innerHTML = "";
          groups.forEach((g) => {
            const c = document.createElement("button");
            c.className = "pg-chip" + (g === group ? " on" : "");
            c.textContent = g;
            c.onclick = () => { group = g; draw(); };
            chips.appendChild(c);
          });

          const key = q.trim().toLowerCase();
          const shown = items.filter((it) =>
            (group === "全部" || (it.group || "未分组") === group) &&
            (!key || (it.name + " " + it.text + " " + (it.tags || []).join(" "))
              .toLowerCase().includes(key)));

          list.innerHTML = "";
          if (!shown.length) {
            note.style.display = "";
            note.innerHTML = items.length
              ? "没有匹配的片段。"
              : "词库还是空的。<br>点开一个文本节点 →「💾 存为片段」，或者点右上角「新建」。";
            return;
          }
          note.style.display = "none";

          shown.forEach((it) => {
            const row = document.createElement("div");
            row.className = "pg-item";

            const head = document.createElement("div");
            head.className = "pg-head";
            const nm = document.createElement("span");
            nm.className = "pg-name";
            nm.textContent = it.name || "未命名";
            const g = document.createElement("span");
            g.className = "pg-group";
            g.textContent = it.group || "未分组";
            head.appendChild(nm);
            head.appendChild(g);

            const txt = document.createElement("div");
            txt.className = "pg-text";
            txt.textContent = it.text;

            const tools = document.createElement("div");
            tools.className = "pg-row";
            const ins = document.createElement("button");
            ins.className = "btn small";
            ins.textContent = "插入";
            ins.onclick = () => insertFragment(it.text);
            const ed = document.createElement("button");
            ed.className = "btn small ghost";
            ed.textContent = "编辑";
            ed.onclick = () => editFragment(it);
            tools.appendChild(ins);
            tools.appendChild(ed);

            row.appendChild(head);
            row.appendChild(txt);
            row.appendChild(tools);
            list.appendChild(row);
          });
        };

        search.oninput = () => { q = search.value; draw(); };
        draw();
      };
      return { title: "词库", body, action: "新建", actionFn: () => editFragment(null) };
    },

    workflows() {
      const body = (b) => {
        const search = document.createElement("input");
        search.className = "search";
        search.placeholder = "搜索工作流…";
        b.appendChild(search);
        const list = document.createElement("div");
        b.appendChild(list);
        const cur = S.wfPath;
        const draw = async () => {
          list.innerHTML = "";
          const all = await listWorkflows();
          const q = search.value.trim().toLowerCase();
          const shown = all.filter((w) => !q || w.path.toLowerCase().includes(q));
          if (!shown.length) {
            list.innerHTML = '<div class="empty">没有找到工作流。<br>' +
              "工作流目录：<br><code>" + esc(B.workflowDir || "") + "</code></div>";
            return;
          }
          let lastDir = null;
          // group by folder so a folder never appears twice in the list
          const byDir = new Map();
          shown.forEach((w) => {
            const d = w.dir || "";
            if (!byDir.has(d)) byDir.set(d, []);
            byDir.get(d).push(w);
          });
          const dirs = Array.from(byDir.keys()).sort((a, b) =>
            a === "" ? -1 : b === "" ? 1 : a.localeCompare(b, "zh"));
          dirs.forEach((d) => {
            const h = document.createElement("div");
            h.className = "group-h";
            h.textContent = d || "根目录";
            list.appendChild(h);
            byDir.get(d)
              .sort((x, y) => y.mtime - x.mtime)
              .forEach((w) => {
                const it = document.createElement("button");
                it.className = "wf-item" + (w.path === cur ? " cur" : "");
                it.innerHTML = '<div class="t">' + esc(w.name) + "</div>" +
                  '<div class="m">' + (w.size / 1024).toFixed(0) + " KB · " +
                  new Date(w.mtime * 1000).toLocaleDateString() + "</div>";
                it.onclick = async () => {
                  closePanel();
                  await openWorkflow(w.path);
                };
                list.appendChild(it);
              });
          });
          const save = document.createElement("button");
          save.className = "btn";
          save.style.marginTop = "14px";
          save.textContent = "💾 把当前画布另存到 _mobile/";
          save.onclick = saveCopy;
          list.appendChild(save);
        };
        search.oninput = draw;
        draw();
      };
      return { title: "工作流", body };
    },

    gallery() {
      const body = async (b) => {
        b.innerHTML = '<div class="empty">读取历史…</div>';
        let listing = { items: [] };
        try { listing = await (await fetch(rel("api/outputs?limit=300"))).json(); } catch (e) {}
        const items = (listing.items || []).slice();
        if (!items.length) {
          b.innerHTML = '<div class="empty">还没有生成结果。<br>点右上角 ▶ 跑一次。</div>';
          return;
        }

        let selecting = false;
        const chosen = new Set();
        const keyOf = (it) => it.type + "|" + it.subfolder + "|" + it.filename;

        b.innerHTML = "";
        const tools = document.createElement("div");
        tools.className = "gal-tools";
        const grid = document.createElement("div");
        grid.className = "grid";
        const bar = document.createElement("div");
        bar.className = "gal-bar";

        tools.innerHTML = '<span class="gal-count"></span>';
        const btnSel = document.createElement("button");
        btnSel.className = "btn small";
        const btnAll = document.createElement("button");
        btnAll.className = "btn small";
        tools.appendChild(btnSel);
        tools.appendChild(btnAll);

        b.appendChild(tools);
        b.appendChild(grid);
        b.appendChild(bar);

        const refreshBar = () => {
          tools.querySelector(".gal-count").textContent =
            "共 " + items.length + " 项" + (selecting ? " · 已选 " + chosen.size : "");
          btnSel.textContent = selecting ? "取消选择" : "选择";
          btnAll.textContent = selecting ? "全选" : "";
          btnAll.style.display = selecting ? "" : "none";
          bar.style.display = selecting ? "" : "none";
          bar.innerHTML = "";
          if (!selecting) return;
          const del = document.createElement("button");
          del.className = "btn small danger";
          del.style.flex = "1 1 0";
          del.textContent = chosen.size ? "删除所选（" + chosen.size + "）" : "删除所选";
          del.disabled = !chosen.size;
          del.onclick = () => removeItems(Array.from(chosen));
          bar.appendChild(del);
        };

        const draw = () => {
          grid.innerHTML = "";
          items.slice(0, 200).forEach((it) => {
            const isVid = /\.(mp4|webm|mov|mkv|avi)$/i.test(it.filename);
            const cell = document.createElement("div");
            cell.className = "g-item" + (chosen.has(keyOf(it)) ? " sel" : "");
            cell.innerHTML = '<img loading="lazy" src="' + esc(thumbUrl(it)) + '" ' +
              'onerror="this.parentNode.classList.add(\'noimg\')">' +
              (isVid ? '<span class="badge">视频</span>' : "") +
              '<span class="g-check">✓</span>';
            cell.onclick = () => {
              if (!selecting) { lightbox(it); return; }
              const k = keyOf(it);
              if (chosen.has(k)) chosen.delete(k); else chosen.add(k);
              cell.classList.toggle("sel", chosen.has(k));
              refreshBar();
            };
            grid.appendChild(cell);
          });
          refreshBar();
        };

        btnSel.onclick = () => {
          selecting = !selecting;
          if (!selecting) chosen.clear();
          draw();
        };
        btnAll.onclick = () => {
          for (const it of items) chosen.add(keyOf(it));
          draw();
        };

        async function removeItems(keys) {
          if (!keys.length) return;
          if (!confirm("把 " + keys.length + " 个文件移到回收站？\n（在电脑的回收站里可以还原）")) return;
          if (keys.length > 10 &&
              !confirm("这次要删 " + keys.length + " 个，数量较多，确定继续？")) return;
          const payload = keys.map((k) => {
            const [type, subfolder, ...rest] = k.split("|");
            return { type, subfolder, filename: rest.join("|") };
          });
          try {
            const r = await (await fetch(rel("api/delete"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ items: payload }),
            })).json();
            if (r.error) { toast(r.error, true); return; }
            toast((r.recycled ? "已移到回收站 " : "已永久删除 ") + r.deleted + " 个" +
              (r.failed && r.failed.length ? "，" + r.failed.length + " 个失败" : ""));
            openPanel("gallery");
          } catch (e) {
            toast("删除失败：" + e.message, true);
          }
        }

        draw();
      };
      return { title: "图库", body, action: "刷新", actionFn: () => openPanel("gallery") };
    },

    queue() {
      const body = async (b) => {
        b.innerHTML = '<div class="empty">读取队列…</div>';
        let q = { queue_running: [], queue_pending: [] };
        try { q = await (await fetch(api("queue"))).json(); } catch (e) {}
        b.innerHTML = "";
        const running = q.queue_running || [];
        const pending = q.queue_pending || [];
        const mk = (arr, label) => {
          if (!arr.length) return;
          const h = document.createElement("div");
          h.className = "group-h";
          h.textContent = label + " (" + arr.length + ")";
          b.appendChild(h);
          arr.forEach((it) => {
            const d = document.createElement("div");
            d.className = "q-item";
            const pid = it[1];
            const nn = Object.keys(it[2] || {}).length;
            d.innerHTML = '<div class="t">' + pid.slice(0, 8) + "…</div>" +
              '<div class="m">' + nn + " 个节点 · " + (it[3] && it[3].client_id ? "来自 " + it[3].client_id.slice(0, 6) : "") + "</div>";
            b.appendChild(d);
          });
        };
        mk(running, "正在运行");
        mk(pending, "排队中");
        if (!running.length && !pending.length) {
          b.innerHTML = '<div class="empty">队列是空的。</div>';
        }
        const stop = document.createElement("button");
        stop.className = "btn danger";
        stop.style.marginTop = "12px";
        stop.textContent = "中断当前任务";
        stop.onclick = async () => {
          await fetch(api("interrupt"), { method: "POST" });
          toast("已发送中断");
          openPanel("queue");
        };
        b.appendChild(stop);
      };
      return { title: "队列", body, action: "刷新", actionFn: () => openPanel("queue") };
    },

    nodelist() {
      const body = (b) => {
        if (!S.doc) { b.innerHTML = '<div class="empty">还没有打开工作流。</div>'; return; }
        const search = document.createElement("input");
        search.className = "search";
        search.placeholder = "搜索节点（标题 / 类型 / 参数值）…";
        b.appendChild(search);
        const list = document.createElement("div");
        b.appendChild(list);
        const draw = () => {
          list.innerHTML = "";
          const q = search.value.trim().toLowerCase();
          const arr = Array.from(S.nodes.values()).filter((n) => {
            if (!q) return true;
            const inf = info(n);
            const hay = [n.title, n.type, nodeZh(n.type), inf.dn, JSON.stringify(values(n)).slice(0, 400)]
              .join(" ").toLowerCase();
            return hay.includes(q);
          });
          if (!arr.length) { list.innerHTML = '<div class="empty">没有匹配的节点</div>'; return; }
          arr.slice(0, 200).forEach((n) => {
            const inf = info(n);
            const it = document.createElement("button");
            it.className = "wf-item";
            it.innerHTML = '<div class="t">#' + n.id + " " +
              esc(n.title || nodeZh(n.type) || inf.dn || n.type) + "</div>" +
              '<div class="m">' + esc(n.type) + "</div>";
            it.onclick = () => {
              closePanel();
              focusNode(n.id);
              openSheet(n.id);
            };
            list.appendChild(it);
          });
        };
        search.oninput = draw;
        draw();
      };
      return { title: "节点列表", body };
    },

    nodes() {
      const body = (b) => {
        const search = document.createElement("input");
        search.className = "search";
        search.placeholder = "搜索节点类型，例如 KSampler / 加载器…";
        b.appendChild(search);
        const list = document.createElement("div");
        b.appendChild(list);
        const draw = () => {
          const q = search.value.trim().toLowerCase();
          if (!q) {
            list.innerHTML = '<div class="empty">输入关键词开始搜索</div>';
            return;
          }
          const hits = [];
          for (const type of Object.keys(S.oi)) {
            const inf = S.oi[type];
            const zh = nodeZh(type) || "";
            const hay = (type + " " + (inf.dn || "") + " " + zh).toLowerCase();
            if (hay.indexOf(q) >= 0) hits.push(type);
            if (hits.length > 80) break;
          }
          list.innerHTML = "";
          if (!hits.length) { list.innerHTML = '<div class="empty">没有匹配</div>'; return; }
          hits.forEach((type) => {
            const inf = S.oi[type];
            const zh = nodeZh(type);
            const it = document.createElement("button");
            it.className = "wf-item";
            it.innerHTML = '<div class="t">' + esc(zh || inf.dn || type) + "</div>" +
              '<div class="m">' + esc(type) + (inf.cat ? " · " + esc(inf.cat) : "") + "</div>";
            it.onclick = () => { closePanel(); addNode(type); };
            list.appendChild(it);
          });
        };
        search.oninput = draw;
        draw();
        setTimeout(() => search.focus(), 250);
      };
      return { title: "添加节点", body };
    },

    settings() {
      const body = async (b) => {
        b.innerHTML = '<div class="empty">读取中…</div>';
        let m = {};
        try { m = await (await fetch(rel("api/meta"))).json(); } catch (e) {}
        b.innerHTML = "";

        const card = document.createElement("div");
        card.className = "q-item";
        card.innerHTML = '<div class="t">ComfyUI Mobile UI</div>' +
          '<div class="m">' + esc(B.version || "?") +
          (m.comfyui ? " · ComfyUI " + esc(m.comfyui) : "") +
          "<br>接口根路径 " + esc(API_ROOT) + "</div>";
        b.appendChild(card);

        const lan = (m.lan || []).filter(Boolean);
        if (lan.length) {
          const h = document.createElement("div");
          h.className = "group-h";
          h.textContent = "手机访问地址";
          b.appendChild(h);
          lan.forEach((u, i) => {
            const row = document.createElement("button");
            row.className = "wf-item";
            row.innerHTML = '<div class="t" style="font-family:ui-monospace,Menlo,monospace;font-size:12.5px">' +
              esc(u) + (i === 0 ? ' <span class="chip">推荐</span>' : "") +
              '</div><div class="m">点击复制</div>';
            row.onclick = () => copyText(u);
            b.appendChild(row);
          });
        } else {
          const warn = document.createElement("div");
          warn.className = "q-item";
          warn.innerHTML = '<div class="t">手机连不上？</div>' +
            '<div class="m">ComfyUI 现在只监听本机（127.0.0.1）。' +
            "用带 <code>--listen 0.0.0.0</code> 的启动器重启后，这里会显示局域网地址。</div>";
          b.appendChild(warn);
        }

        const reload = document.createElement("button");
        reload.className = "btn";
        reload.style.marginTop = "12px";
        reload.textContent = "重新读取节点信息";
        reload.onclick = async () => {
          S.oiFull = {};
          const oi = await (await fetch(rel("api/object_info?refresh=1"))).json();
          if (!oi.error) { S.oi = oi; toast("已刷新 " + Object.keys(oi).length + " 种节点"); }
        };
        b.appendChild(reload);

        const fit = document.createElement("button");
        fit.className = "btn";
        fit.style.marginTop = "8px";
        fit.textContent = "回到全图";
        fit.onclick = () => { closePanel(); fitAll(); };
        b.appendChild(fit);
      };
      return { title: "设置", body };
    },
  };

  async function saveCopy() {
    if (!S.doc) return;
    const name = prompt("保存为（会写进 workflows/_mobile/）", (S.wfName || "手机副本") + "-mobile");
    if (!name) return;
    const body = { name: name.replace(/\.json$/i, "") + ".json", workflow: serializeDoc() };
    try {
      const r = await (await fetch(rel("api/workflow"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })).json();
      if (r.error) { toast(r.error, true); return; }
      S.dirty = false;
      updateTitle();
      toast("已保存到 " + r.path);
    } catch (e) {
      toast("保存失败：" + e.message, true);
    }
  }

  /* =================================================================== adding */

  function addNode(type) {
    if (!S.doc) { toast("先打开一个工作流", true); return; }
    const inf = S.oi[type] || {};
    let id = 1;
    S.nodes.forEach((_, k) => { id = Math.max(id, k + 1); });
    const r = vpRect();
    const center = toGraph(r.left + r.width / 2, r.top + r.height / 3);
    const vals = {};
    const arr = [];
    MUConv.widgetSpecs(inf).forEach(([name, spec, opts]) => {
      let d = opts.default;
      if (d === undefined) {
        if (Array.isArray(opts.options) && opts.options.length) d = opts.options[0];
        else if (spec[0] === "INT") d = 0;
        else if (spec[0] === "FLOAT") d = 1;
        else if (spec[0] === "BOOLEAN") d = false;
        else d = "";
      }
      vals[name] = d;
      arr.push(d);
      if (opts.control_after_generate) arr.push("fixed");
    });
    const node = {
      id,
      type,
      pos: [Math.round(center[0] - 100), Math.round(center[1] - 40)],
      size: [200, 70],
      flags: {},
      order: 0,
      mode: 0,
      inputs: [],
      outputs: (inf.out || []).map((t, i) => ({
        name: (inf.outn && inf.outn[i]) || t, type: t, links: null,
      })),
      properties: { "Node name for S&R": type },
      widgets_values: arr,
      widgets_values_named: vals,
    };
    const secs = ["required", "optional"];
    secs.forEach((sec) => {
      const d = (inf.in && inf.in[sec]) || {};
      for (const name of Object.keys(d)) {
        const spec = d[name];
        if (MUConv.isWidgetSpec(spec)) continue;
        node.inputs.push({ name, type: spec[0], link: null });
      }
    });
    S.nodes.set(id, node);
    if (S.doc) S.doc.last_node_id = Math.max(S.doc.last_node_id || 0, id);
    S.dirty = true;
    render();
    updateTitle();
    focusNode(id);
    openSheet(id);
  }

  function serializeDoc() {
    const doc = S.doc || { nodes: [], links: [] };
    const links = [];
    S.links.forEach((l) => links.push([l.id, l.origin, l.oslot, l.target, l.tslot, l.type || "*"]));
    doc.links = links;
    let maxNode = 0, maxLink = 0;
    S.nodes.forEach((n) => { maxNode = Math.max(maxNode, n.id); });
    S.links.forEach((l) => { maxLink = Math.max(maxLink, l.id); });
    doc.last_node_id = Math.max(doc.last_node_id || 0, maxNode);
    doc.last_link_id = Math.max(doc.last_link_id || 0, maxLink);

    S.nodes.forEach((n) => {
      (n.outputs || []).forEach((o) => { o.links = null; });
      (n.inputs || []).forEach((inp) => { inp.link = null; });
    });
    S.links.forEach((l) => {
      const src = S.nodes.get(l.origin);
      if (src && src.outputs && src.outputs[l.oslot]) {
        const o = src.outputs[l.oslot];
        o.links = o.links || [];
        o.links.push(l.id);
      }
      const dst = S.nodes.get(l.target);
      if (dst && dst.inputs && dst.inputs[l.tslot]) dst.inputs[l.tslot].link = l.id;
    });
    doc.nodes = Array.from(S.nodes.values());
    return doc;
  }

  /* ================================================================= upload */

  /* =============================================================== crop picker */
  /* Sliders cannot express "this part of the picture": x=192 means nothing until
   * you see it. For crop nodes whose image comes straight from a LoadImage, this
   * shows the actual image and writes the dragged box back into the widgets. */

  function cropKeys(n) {
    const have = new Set(MUConv.widgetSpecs(info(n)).map((s) => s[0]));
    if (have.has("x") && have.has("y") && have.has("width") && have.has("height")) return "xywh";
    if (have.has("crop_region")) return "box";
    return null;
  }

  function upstreamImage(n) {
    for (const inp of n.inputs) {
      if (inp.link == null || !/IMAGE/.test(String(inp.type || ""))) continue;
      const l = S.links.get(inp.link);
      const src = l && S.nodes.get(l.origin);
      if (!src) continue;
      const v = values(src);
      const fn = v.image || v.image_file;
      if (typeof fn === "string" && fn) return { node: src, filename: fn };
    }
    return null;
  }

  function openCropPicker(n) {
    const inf = info(n);
    const mode = cropKeys(n);
    const src = upstreamImage(n);
    if (!src) { toast("上游不是「加载图像」，没法预览原图", true); return; }

    const vals = values(n);
    const region = mode === "box" && vals.crop_region && typeof vals.crop_region === "object"
      ? vals.crop_region : null;
    let rect = {
      x: +(region ? region.x : vals.x) || 0,
      y: +(region ? region.y : vals.y) || 0,
      w: +(region ? region.width : vals.width) || 0,
      h: +(region ? region.height : vals.height) || 0,
    };

    const back = document.createElement("div");
    back.className = "crop-back";
    back.innerHTML =
      '<div class="crop-top">正在加载原图…</div>' +
      '<div class="crop-stage"><img class="crop-img" alt=""><div class="crop-box">' +
      '<i data-k="nw"></i><i data-k="ne"></i><i data-k="sw"></i><i data-k="se"></i></div></div>' +
      '<div class="crop-bar"></div>';
    document.body.appendChild(back);

    const top = back.querySelector(".crop-top");
    const stage = back.querySelector(".crop-stage");
    const img = back.querySelector(".crop-img");
    const box = back.querySelector(".crop-box");
    const bar = back.querySelector(".crop-bar");
    let scale = 1;

    const close = () => { window.removeEventListener("resize", layout); back.remove(); };
    pushOverlay("crop", close);

    function paint() {
      const r = stage.getBoundingClientRect();
      const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
      const left = (r.width - iw * scale) / 2, topPx = (r.height - ih * scale) / 2;
      box.style.left = left + rect.x * scale + "px";
      box.style.top = topPx + rect.y * scale + "px";
      box.style.width = rect.w * scale + "px";
      box.style.height = rect.h * scale + "px";
      top.textContent = "x " + Math.round(rect.x) + "  y " + Math.round(rect.y) +
        "    " + Math.round(rect.w) + " × " + Math.round(rect.h) +
        "    原图 " + iw + " × " + ih;
    }

    function layout() {
      const r = stage.getBoundingClientRect();
      const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
      scale = Math.min(r.width / iw, r.height / ih);
      img.style.width = iw * scale + "px";
      img.style.height = ih * scale + "px";
      img.style.left = (r.width - iw * scale) / 2 + "px";
      img.style.top = (r.height - ih * scale) / 2 + "px";
      if (!rect.w || !rect.h) rect = { x: 0, y: 0, w: iw, h: ih };
      rect.x = clamp(Math.round(rect.x), 0, Math.max(0, iw - 8));
      rect.y = clamp(Math.round(rect.y), 0, Math.max(0, ih - 8));
      rect.w = clamp(Math.round(rect.w), 8, iw - rect.x);
      rect.h = clamp(Math.round(rect.h), 8, ih - rect.y);
      paint();
    }

    let applyBtn = null;

    img.onload = () => {
      layout();
      if (applyBtn) applyBtn.disabled = false;
    };
    img.onerror = () => {
      top.textContent = "原图加载失败：" + src.filename + "（不在 input/ 目录里，先在「加载图像」节点上传）";
    };
    buildBar();
    img.src = api("view?filename=" + encodeURIComponent(src.filename) + "&type=input");
    window.addEventListener("resize", layout);

    let drag = null;
    box.addEventListener("pointerdown", (e) => {
      drag = {
        kind: (e.target.dataset && e.target.dataset.k) || "move",
        px: e.clientX, py: e.clientY,
        start: Object.assign({}, rect),
      };
      try { box.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    box.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
      const dx = (e.clientX - drag.px) / scale;
      const dy = (e.clientY - drag.py) / scale;
      const s = drag.start;
      if (drag.kind === "move") {
        rect = {
          x: Math.round(clamp(s.x + dx, 0, iw - s.w)),
          y: Math.round(clamp(s.y + dy, 0, ih - s.h)),
          w: s.w, h: s.h,
        };
      } else {
        let L = s.x, T = s.y, R = s.x + s.w, B = s.y + s.h;
        if (drag.kind.indexOf("w") >= 0) L = clamp(s.x + dx, 0, R - 8);
        if (drag.kind.indexOf("e") >= 0) R = clamp(s.x + s.w + dx, L + 8, iw);
        if (drag.kind.indexOf("n") >= 0) T = clamp(s.y + dy, 0, B - 8);
        if (drag.kind.indexOf("s") >= 0) B = clamp(s.y + s.h + dy, T + 8, ih);
        rect = { x: Math.round(L), y: Math.round(T), w: Math.round(R - L), h: Math.round(B - T) };
      }
      paint();
    });
    const stop = () => { drag = null; };
    box.addEventListener("pointerup", stop);
    box.addEventListener("pointercancel", stop);

    function apply() {
      if (!img.naturalWidth) {
        toast("原图没加载成功，没法框选", true);
        return;
      }
      if (mode === "box") {
        MUConv.setValue(n, inf, "crop_region", {
          x: rect.x, y: rect.y, width: rect.w, height: rect.h,
        });
      } else {
        const ws = new Set(MUConv.widgetSpecs(inf).map((s) => s[0]));
        [["x", rect.x], ["y", rect.y], ["width", rect.w], ["height", rect.h]].forEach(([k, v]) => {
          if (ws.has(k)) MUConv.setValue(n, inf, k, v);
        });
      }
      S.dirty = true;
      if (!popOverlay("crop")) close();
      render();
      openSheet(n.id);
      updateTitle();
      toast("已写入 " + rect.w + "×" + rect.h + " @" + rect.x + "," + rect.y);
    }

    function buildBar() {
      const mk = (label, cls, fn) => {
        const b2 = document.createElement("button");
        b2.className = "crop-btn" + (cls ? " " + cls : "");
        b2.textContent = label;
        b2.onclick = fn;
        bar.appendChild(b2);
        return b2;
      };
      mk("全图", "", () => {
        if (!img.naturalWidth) return;
        rect = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
        paint();
      });
      mk("居中", "", () => {
        if (!img.naturalWidth) return;
        const iw = img.naturalWidth, ih = img.naturalHeight;
        const w = Math.min(rect.w || iw, iw), h = Math.min(rect.h || ih, ih);
        rect = { x: Math.round((iw - w) / 2), y: Math.round((ih - h) / 2), w, h };
        paint();
      });
      mk("取消", "", () => { if (!popOverlay("crop")) close(); });
      applyBtn = mk("应用", "primary", apply);
      applyBtn.disabled = true;
    }
  }

  /* The node table is a snapshot taken when the page opened, and the server
   * caches it for 30 minutes. A file uploaded a minute ago is therefore absent
   * from the combo lists even though it is on disk and ComfyUI will accept it.
   * Ask the file itself instead of trusting the snapshot. */
  async function inputExists(name, type) {
    try {
      const r = await fetch(api("view?filename=" + encodeURIComponent(name) +
        "&type=" + encodeURIComponent(type || "input")), { method: "HEAD" });
      return r.ok;
    } catch (_) {
      return false;
    }
  }

  /** Pull fresh combo options for one node type after an upload, so the picker
   *  shows the new file without reloading the whole 2.6MB table. */
  async function refreshTypeOptions(type) {
    try {
      const raw = await (await fetch(api("object_info/" + encodeURIComponent(type)))).json();
      const full = raw[type];
      const slim = S.oi[type];
      if (!full || !slim) return;
      ["required", "optional"].forEach((sec) => {
        const src = (full.input && full.input[sec]) || {};
        const dst = (slim.in && slim.in[sec]) || {};
        Object.keys(dst).forEach((name) => {
          const s = src[name];
          if (!Array.isArray(s)) return;
          const opts = Array.isArray(s[0]) ? s[0] : (s[1] && s[1].options);
          if (!Array.isArray(opts)) return;
          if (!dst[name][1]) dst[name][1] = {};
          dst[name][1].options = opts;
          delete dst[name][1]._more;
        });
      });
    } catch (_) {}
  }

  function pickImage(cb) {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.style.display = "none";
    document.body.appendChild(inp);
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      document.body.removeChild(inp);
      if (!f) return;
      toast("上传中…");
      const fd = new FormData();
      fd.append("image", f, f.name || "photo.jpg");
      fd.append("type", "input");
      fd.append("overwrite", "true");
      try {
        const r = await (await fetch(api("upload/image"), { method: "POST", body: fd })).json();
        if (r.error) { toast("上传失败：" + r.error, true); return; }
        const name = r.subfolder ? r.subfolder + "/" + r.name : r.name;
        cb(name);
      } catch (e) {
        toast("上传失败：" + e.message, true);
      }
    };
    inp.click();
  }

  /* =============================================================== lightbox */

  function thumbUrl(it, w) {
    return rel("api/thumb") + "?filename=" + encodeURIComponent(it.filename) +
      "&subfolder=" + encodeURIComponent(it.subfolder) +
      "&type=" + encodeURIComponent(it.type) + "&w=" + (w || 320);
  }

  function lightbox(it) {
    const back = document.createElement("div");
    back.className = "lightbox";

    const stage = document.createElement("div");
    stage.className = "lb-stage";
    stage.innerHTML = '<div class="lb-spin">正在加载原图…</div>';

    const isVid = /\.(mp4|webm|mov|mkv|avi)$/i.test(it.filename);
    const url = api("view?filename=" + encodeURIComponent(it.filename) +
      "&subfolder=" + encodeURIComponent(it.subfolder) +
      "&type=" + encodeURIComponent(it.type));

    // The full file is requested here and nowhere else: the grid only ever
    // pulls a thumbnail, so opening a picture is the one time it is paid for.
    const media = document.createElement(isVid ? "video" : "img");
    if (isVid) {
      media.controls = true;
      media.autoplay = true;
      media.playsInline = true;
    }
    const show = () => { stage.innerHTML = ""; stage.appendChild(media); };
    media.onload = show;
    media.onloadeddata = show;
    media.onerror = () => { stage.textContent = "加载失败"; };
    media.src = url;

    const bar = document.createElement("div");
    bar.className = "lb-bar";
    const dl = document.createElement("a");
    dl.href = url;
    dl.download = it.filename.split("/").pop();
    dl.textContent = "保存到本机";
    dl.className = "lb-save";
    const close = document.createElement("button");
    close.textContent = "关闭";
    close.className = "lb-close";
    close.onclick = () => { if (!popOverlay("lightbox")) back.remove(); };
    bar.appendChild(dl);
    bar.appendChild(close);

    back.appendChild(stage);
    back.appendChild(bar);
    back.onclick = (e) => {
      if (e.target !== back) return;
      if (!popOverlay("lightbox")) back.remove();
    };
    document.body.appendChild(back);
    pushOverlay("lightbox", () => { if (back.parentNode) back.remove(); });
  }

  /* =================================================================== debug */
  /* A phone has no console and no inspector, so when the server allows it this
   * page reports what it is actually showing, and executes a fixed whitelist of
   * pushed actions. Nothing here evaluates strings: the worst a caller can do is
   * reload, open a workflow, open a node's sheet, or show a toast. */
  const JS_ERRORS = [];

  function snapshot() {
    const sheetOpen = $("#sheet").classList.contains("open");
    const n = S.sel ? S.nodes.get(S.sel) : null;
    const inf = n ? info(n) : null;
    const ws = inf ? MUConv.widgetSpecs(inf) : [];
    const q = (sel) => document.querySelectorAll(sel).length;
    return {
      href: location.href,
      ua: navigator.userAgent,
      oi: Object.keys(S.oi || {}).length,
      oiError: S.oiError || "",
      wf: S.wfPath,
      nodes: S.nodes.size,
      view: { z: +S.view.z.toFixed(3), x: Math.round(S.view.x), y: Math.round(S.view.y) },
      sheet: sheetOpen && n ? {
        id: n.id, type: n.type, fields: ws.length,
        linked: ws.filter((s) => isLinked(n, s[0])).length,
        enabled: q("#sheetBody input:not([disabled]),#sheetBody textarea:not([disabled]),#sheetBody select:not([disabled])"),
        allControls: q("#sheetBody input,#sheetBody textarea,#sheetBody select"),
      } : null,
      errors: JS_ERRORS.slice(-6),
    };
  }

  function sendReport() {
    fetch(rel("api/debug/report"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot()),
    }).catch(() => {});
  }

  function runCommand(c) {
    const a = c.action, arg = c.arg;
    if (a === "reload") { location.reload(); return; }
    if (a === "open" && arg) { openWorkflow(arg); return; }
    if (a === "sheet" && arg != null) { closePanel(); focusNode(+arg); openSheet(+arg); return; }
    if (a === "fit") { fitAll(); return; }
    if (a === "toast") { toast(String(arg || "")); return; }
    if (a === "repair") { const f = repairComboPaths(); render(); toast("已修正 " + f.length + " 处"); return; }
    if (a === "probe") { sendReport(); }
  }

  function startDebug() {
    window.addEventListener("error", (e) => {
      JS_ERRORS.push(String(e.message) + " @" + String(e.filename || "").split("/").pop() + ":" + e.lineno);
    });
    window.addEventListener("unhandledrejection", (e) => {
      const r = e.reason;
      JS_ERRORS.push("unhandled: " + String((r && r.message) || r));
    });
    sendReport();
    setInterval(sendReport, 20000);
    setInterval(async () => {
      try {
        const r = await (await fetch(rel("api/debug/poll"))).json();
        (r.commands || []).forEach(runCommand);
      } catch (_) {}
    }, 4000);
  }

  /* ==================================================================== go */

  boot();
  if (B.debug) startDebug();
  // exposed for the _dev test harness; harmless in normal use
  window.__MUI__ = {
    S, api, openPanel, fitAll, runOrStop, focus: focusNode, sheet: openSheet, connect,
    overlayKinds: () => overlayStack.map((e) => e.kind),
    preflight, inputExists,
  };
})();
