/* UI-workflow -> API-prompt conversion.
 *
 * ComfyUI's canvas stores a graph (nodes with positions, a links table, and a
 * loose widgets_values array); /prompt wants {nodeId: {class_type, inputs}}.
 * The translation is the risky part of a third-party editor, so it lives in
 * this one small file, is pure (no DOM), and is covered by a test that diffs
 * its output against real API-format exports.
 *
 * Rules verified against this machine's own exports:
 *   - array/object widget values are wrapped as {"__value__": v}, because a
 *     bare array is indistinguishable from a [nodeId, slot] link;
 *   - dynamic-combo sub-fields ("format.codec", "mode.scale") are real inputs;
 *   - Note / MarkdownNote / Reroute / PrimitiveNode never reach the API;
 *   - muted and bypassed nodes never reach it either, but bypassed ones are
 *     followed so their consumers still get a source.
 */
(function (global, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else global.MUConv = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var FRONTEND_ONLY = { Note: 1, MarkdownNote: 1, Reroute: 1, PrimitiveNode: 1 };

  var MODE_MUTE = 2;
  var MODE_BYPASS = 4;

  function inputsOf(info) {
    if (!info) return {};
    return info["in"] || info.input || {};
  }

  function section(info, which) {
    var s = inputsOf(info)[which];
    return s && typeof s === "object" ? s : {};
  }

  /** Types the canvas renders as a widget rather than a socket. */
  var PRIMITIVE = {
    INT: 1, FLOAT: 1, STRING: 1, BOOLEAN: 1,
    COMBO: 1, COMFY_DYNAMICCOMBO_V3: 1,
  };

  /* Widget types that are not primitives. Kept as an explicit list, not "has a
   * default": on this install 132 inputs are sockets that carry a default (34 of
   * them type "*", 7 MASK, 2 IMAGE), and treating those as widgets would drop
   * them out of the prompt instead of wiring them. */
  var EXTRA_WIDGET = { COLOR: 1, GHCOLOR: 1, COLORCODE: 1, COLORS: 1 };

  /* Compound numeric types some packs declare as widgets: "INT:seed",
   * "INT,FLOAT", "FLOAT,INT". Deliberately excludes anything starting with
   * STRING, because "STRING,FILE_3D_GLB,..." is a file socket, not a text box. */
  var COMPOUND_NUM = /^(INT|FLOAT|BOOLEAN)([,:][A-Za-z0-9_]+)+$/;

  function isColorType(typ) {
    return !!EXTRA_WIDGET[typ] && typ !== "COLORS";
  }

  /** True when an INPUT_TYPES entry is rendered as a widget (so its value can
   *  live in widgets_values) rather than as a socket.
   *
   *  The rule is the declared type, not the presence of a default:
   *  CLIPTextEncode's `text` is ("STRING", {multiline: true}) with no default
   *  and is still a text box. `forceInput: true` demotes any of them. */
  function isWidgetSpec(spec) {
    if (!Array.isArray(spec) || !spec.length) return false;
    var typ = spec[0];
    var opt = spec.length > 1 && spec[1] && typeof spec[1] === "object" ? spec[1] : {};
    if (Array.isArray(typ)) return true;              // legacy COMBO
    if (opt.forceInput) return false;
    if (typeof typ !== "string") return false;
    if (PRIMITIVE[typ]) return true;
    if (EXTRA_WIDGET[typ]) return true;
    if (COMPOUND_NUM.test(typ)) return true;
    return false;
  }

  /** Ordered widget-capable inputs of a node type: [[name, spec, opts], ...] */
  function widgetSpecs(info) {
    var out = [];
    var push = function (sec) {
      var d = section(info, sec);
      for (var name in d) {
        if (!Object.prototype.hasOwnProperty.call(d, name)) continue;
        var spec = d[name];
        if (isWidgetSpec(spec)) {
          out.push([name, spec, (spec.length > 1 && spec[1]) || {}]);
        }
      }
    };
    push("required");
    push("optional");
    return out;
  }

  /** Every input name a node type actually declares, required and optional. */
  function declaredKeys(info) {
    var keys = {};
    ["required", "optional"].forEach(function (sec) {
      var d = section(info, sec);
      for (var k in d) {
        if (Object.prototype.hasOwnProperty.call(d, k)) keys[k] = 1;
      }
    });
    return keys;
  }

  /** Is `key` something the API would accept for this node type?
   *  Either a declared input, or a dynamic sub-field of one ("format.codec",
   *  "mode.scale", "values.a"). Everything else - front-end-only extras such as
   *  a widget a node's JS bolted on and later dropped from INPUT_TYPES - is
   *  filtered out so the prompt matches what ComfyUI itself would send. */
  function isAcceptableKey(key, declared) {
    if (declared[key]) return true;
    var dot = key.indexOf(".");
    if (dot > 0 && declared[key.slice(0, dot)]) return true;
    return false;
  }

  function linkTable(doc) {
    var m = new Map();
    var raw = (doc && doc.links) || [];
    for (var i = 0; i < raw.length; i++) {
      var l = raw[i];
      if (Array.isArray(l)) {
        m.set(l[0], { id: l[0], origin: l[1], oslot: l[2], target: l[3], tslot: l[4], type: l[5] });
      } else if (l && typeof l === "object") {
        m.set(l.id, {
          id: l.id, origin: l.origin_id, oslot: l.origin_slot,
          target: l.target_id, tslot: l.target_slot, type: l.type
        });
      }
    }
    return m;
  }

  function nodeTable(doc) {
    var m = new Map();
    var ns = (doc && doc.nodes) || [];
    for (var i = 0; i < ns.length; i++) m.set(ns[i].id, ns[i]);
    return m;
  }

  /** "MODEL" vs "MODEL,CLIP" vs "*" */
  function typesCompatible(a, b) {
    if (!a || !b) return true;
    if (a === "*" || b === "*") return true;
    if (a === b) return true;
    var sa = String(a).split(",");
    var sb = String(b).split(",");
    for (var i = 0; i < sa.length; i++) {
      var x = sa[i].trim();
      if (!x || x === "*") return true;
      for (var j = 0; j < sb.length; j++) {
        var y = sb[j].trim();
        if (!y || y === "*" || x === y) return true;
      }
    }
    return false;
  }

  /** Widget values of a node, by name.
   *  Prefers `widgets_values_named` (present since ~0.3.x, and in every
   *  workflow on this machine); falls back to positional alignment. */
  function getValues(node, info) {
    var out = {};
    var named = node.widgets_values_named;
    var arr = node.widgets_values || [];

    if (named && typeof named === "object" && !Array.isArray(named)) {
      for (var k in named) {
        if (Object.prototype.hasOwnProperty.call(named, k)) out[k] = named[k];
      }
      // Fill anything the named map lacks from the positional array.
      var idx = 0;
      var specs = widgetSpecs(info);
      for (var i = 0; i < specs.length; i++) {
        var s = specs[i];
        if (idx >= arr.length) break;
        if (!Object.prototype.hasOwnProperty.call(out, s[0])) out[s[0]] = arr[idx];
        idx++;
        if (s[2] && s[2].control_after_generate) idx++;
      }
      return out;
    }

    var pos = 0;
    var ws = widgetSpecs(info);
    for (var j = 0; j < ws.length; j++) {
      if (pos >= arr.length) break;
      out[ws[j][0]] = arr[pos++];
      if (ws[j][2] && ws[j][2].control_after_generate && pos < arr.length) {
        out.control_after_generate = arr[pos++];
      }
    }
    return out;
  }

  /** Index of a widget inside the positional `widgets_values` array, or -1. */
  function valueIndex(info, name) {
    var ws = widgetSpecs(info);
    var idx = 0;
    for (var i = 0; i < ws.length; i++) {
      if (ws[i][0] === name) return idx;
      idx++;
      if (ws[i][2] && ws[i][2].control_after_generate) {
        if (name === "control_after_generate") return idx;
        idx++;
      }
    }
    return -1;
  }

  /** Write a widget value back into both representations the file carries. */
  function setValue(node, info, name, value) {
    if (!node.widgets_values_named || typeof node.widgets_values_named !== "object") {
      node.widgets_values_named = {};
    }
    node.widgets_values_named[name] = value;
    var i = valueIndex(info, name);
    if (i >= 0) {
      if (!Array.isArray(node.widgets_values)) node.widgets_values = [];
      while (node.widgets_values.length <= i) node.widgets_values.push(null);
      node.widgets_values[i] = value;
    }
  }

  function wrap(v) {
    if (v !== null && typeof v === "object") return { __value__: v };
    return v;
  }

  /** Convert a UI-format document into an API prompt.
   *  opts.randomize: honour control_after_generate ("randomize"/"increment"). */
  function convert(doc, oi, opts) {
    opts = opts || {};
    var nodes = nodeTable(doc);
    var links = linkTable(doc);
    var errors = [];
    var warnings = [];
    var prompt = {};
    var randomize = !!opts.randomize;
    var seedState = opts.seedState || {};

    function resolve(linkId, depth) {
      depth = depth || 0;
      if (depth > 64) {
        errors.push("接线里存在循环引用");
        return null;
      }
      var l = links.get(linkId);
      if (!l) return null;
      var src = nodes.get(l.origin);
      if (!src) return null;

      var mode = src.mode | 0;
      if (mode === MODE_MUTE) return null;

      if (src.type === "PrimitiveNode") {
        var pv = (src.widgets_values || [])[0];
        return { literal: pv };
      }

      if (src.type === "Reroute" || mode === MODE_BYPASS) {
        var outType = (src.outputs && src.outputs[l.oslot] && src.outputs[l.oslot].type) || l.type || "*";
        var pick = null;
        var ins = src.inputs || [];
        if (mode === MODE_BYPASS && ins[l.oslot] && ins[l.oslot].link !== null && ins[l.oslot].link !== undefined) {
          pick = ins[l.oslot];
        }
        if (!pick) {
          for (var i = 0; i < ins.length; i++) {
            if (ins[i].link !== null && ins[i].link !== undefined && typesCompatible(ins[i].type, outType)) {
              pick = ins[i];
              break;
            }
          }
        }
        if (!pick || pick.link === null || pick.link === undefined) return null;
        return resolve(pick.link, depth + 1);
      }

      return { link: [String(l.origin), l.oslot] };
    }

    var docNodes = (doc && doc.nodes) || [];
    for (var ni = 0; ni < docNodes.length; ni++) {
      var node = docNodes[ni];
      var type = node.type;
      if (FRONTEND_ONLY[type]) continue;
      var mode = node.mode | 0;
      if (mode === MODE_MUTE || mode === MODE_BYPASS) continue;

      var info = oi && oi[type];
      if (!info) {
        if (type && type.indexOf("workflow") === 0) {
          warnings.push("#" + node.id + " 是子图(subgraph)，手机端暂不支持，已跳过");
        } else {
          errors.push("#" + node.id + " " + type + "：本机未安装该节点类型");
        }
        continue;
      }

      var inputs = {};
      var linked = {};
      var ins2 = node.inputs || [];
      for (var k = 0; k < ins2.length; k++) {
        var inp = ins2[k];
        if (inp.link === null || inp.link === undefined) continue;
        var r = resolve(inp.link, 0);
        if (!r) { linked[inp.name] = 1; continue; }
        if (Object.prototype.hasOwnProperty.call(r, "literal")) {
          inputs[inp.name] = r.literal;
        } else {
          inputs[inp.name] = r.link;
        }
        linked[inp.name] = 1;
      }

      var vals = getValues(node, info);
      var declared = declaredKeys(info);
      var cag = vals.control_after_generate;
      for (var name in vals) {
        if (!Object.prototype.hasOwnProperty.call(vals, name)) continue;
        if (name === "control_after_generate") continue;
        if (linked[name]) continue;
        if (!isAcceptableKey(name, declared)) continue;
        var v = vals[name];
        if (v === undefined) continue;

        if (randomize && cag && name.toLowerCase().indexOf("seed") >= 0) {
          if (cag === "randomize") {
            v = Math.floor(Math.random() * 1125899906842624);
          } else if (cag === "increment" && typeof v === "number") {
            v = v + 1;
            setValue(node, info, name, v);
          }
          seedState[name] = v;
        }
        inputs[name] = wrap(v);
      }

      var req = section(info, "required");
      for (var rn in req) {
        if (!Object.prototype.hasOwnProperty.call(req, rn)) continue;
        if (rn in inputs) continue;
        if (isWidgetSpec(req[rn])) continue;   // widgets carry a default
        // A dynamic-slot input is satisfied by whatever slots exist, and its
        // minimum may be zero; ComfyUI validates the real count.
        if (Array.isArray(req[rn]) && req[rn][0] === "COMFY_AUTOGROW_V3") continue;
        // Grouped sockets: a declared input "values" is exposed by the canvas
        // as "values.a"/"values.b", and only the used ones are sent.
        var grouped = false;
        for (var kk in inputs) {
          if (kk.indexOf(rn + ".") === 0) { grouped = true; break; }
        }
        if (grouped) continue;
        errors.push("#" + node.id + " " + type + "：必填输入 \"" + rn + "\" 没有接线");
      }

      prompt[String(node.id)] = { class_type: type, inputs: inputs };
    }

    if (!Object.keys(prompt).length) errors.push("没有可执行的节点");
    return { prompt: prompt, errors: errors, warnings: warnings };
  }

  return {
    convert: convert,
    getValues: getValues,
    setValue: setValue,
    valueIndex: valueIndex,
    widgetSpecs: widgetSpecs,
    isWidgetSpec: isWidgetSpec,
    isColorType: isColorType,
    typesCompatible: typesCompatible,
    linkTable: linkTable,
    nodeTable: nodeTable,
    FRONTEND_ONLY: FRONTEND_ONLY
  };
});
