"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
const plotDiv = document.getElementById("plot");
const pointsPanel = document.getElementById("pointsPanel");
const resetBtn = document.getElementById("resetBtn");
const splineToggle = document.getElementById("splineToggle");
const editTangents = document.getElementById("editTangents");
const tensionValue = document.getElementById("tensionValue");
const snapGrid = document.getElementById("snapGrid");
const gridStepInput = document.getElementById("gridStep");
const gridStepValue = document.getElementById("gridStepValue");
let points = [];
let nextId = 1;
// ---- Drag state ----
let draggingHandlePointId = null;
let draggingPointId = null;
// For click-suppression after a drag (works for mouse/touch/pen)
let isPointerDown = false;
let dragDistanceSq = 0;
let lastPointerPos = null;
let suppressNextClick = false;
// Picking tolerances (in data units; adjust to taste)
const HANDLE_TOL = 0.5;
const POINT_TOL = 0.4;
// ------- Plotly setup -------
const layout = {
    margin: { l: 50, r: 20, t: 30, b: 50 },
    hovermode: false,
    xaxis: { tickmode: "linear", dtick: 1, showgrid: true, range: [-10, 10], gridcolor: "#eee" },
    yaxis: { tickmode: "linear", dtick: 1, showgrid: true, range: [-5, 5], gridcolor: "#eee" },
    gridwidth: 1,
    showgrid: true,
    showlegend: false,
    dragmode: "pan",
    //width: plotDiv.clientWidth,
    //height: plotDiv.clientWidth,
};
const traceCurve = {
    x: [],
    y: [],
    mode: "lines",
    line: { color: "#ff7f0e", width: 3 }, // custom Hermite curve
    name: "Curve",
};
const traceMarkers = {
    x: [],
    y: [],
    mode: "markers",
    marker: { color: "#1f77b4", size: 8 },
    name: "Points",
};
const traceHandles = {
    x: [],
    y: [],
    mode: "markers",
    marker: { color: "#ff7f0e", size: 8, symbol: "square" },
    name: "Handles",
    visible: true,
};
const traceHandleLinks = {
    x: [],
    y: [],
    mode: "lines",
    line: { color: "#ff7f0e", width: 1, dash: "dot" },
    name: "Handle Links",
    visible: true,
};
const config = {
    displayModeBar: true,
    scrollZoom: true, // no wheel zoom
    doubleClick: false, // no double-click autoscale
    modeBarButtonsToRemove: [
        'zoom2d', 'pan2d', 'select2d', 'lasso2d',
        'zoomIn2d', 'zoomOut2d', 'autoScale2d', 'resetScale2d'
    ],
    responsive: true,
};
Plotly.newPlot(plotDiv, [traceCurve, traceMarkers, traceHandleLinks, traceHandles], layout, config);
// ------- Math helpers -------
function H00(t) { return 2 * t * t * t - 3 * t * t + 1; }
function H10(t) { return t * t * t - 2 * t * t + t; }
function H01(t) { return -2 * t * t * t + 3 * t * t; }
function H11(t) { return t * t * t - t * t; }
function add(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
function mul(a, s) { return { x: a.x * s, y: a.y * s }; }
function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
function len(a) { return Math.hypot(a.x, a.y); }
function clampHandleMagnitude(p0, p1, h) {
    const chord = len(sub(p1, p0));
    const maxMag = Math.max(0.0001, 1.5 * chord);
    const mag = len(h);
    if (mag <= maxMag)
        return h;
    const s = maxMag / mag;
    return mul(h, s);
}
// Compute auto tangents (Catmull-Rom style) for points sorted by x.
function computeAutoTangents(sorted, tension) {
    const m = {};
    const n = sorted.length;
    const l = 5;
    for (let i = 0; i < n; i++) {
        const p = sorted[i];
        let tangent = { x: 0, y: 0 };
        if (n === 1) {
            tangent = { x: 0, y: 0 };
        }
        else if (i === 0) {
            const p1 = sorted[i + 1];
            tangent = { x: 5, y: 0 };
        }
        else if (i === n - 1) {
            const pm1 = sorted[i - 1];
            tangent = { x: 5, y: 0 };
        }
        else {
            const pNext = sorted[i + 1];
            const pPrev = sorted[i - 1];
            tangent = { x: 5, y: 0 };
        }
        m[p.id] = tangent;
    }
    return m;
}
// ------- Grid snapping -------
function gridStep() {
    const v = parseFloat(gridStepInput.value);
    return isFinite(v) && v > 0 ? v : 0.5;
}
function snapVal(v, step) {
    return Math.round(v / step) * step;
}
function snapPoint(p, step) {
    return { x: snapVal(p.x, step), y: snapVal(p.y, step) };
}
function snapIfEnabled(p, shiftBypass) {
    if (!snapGrid.checked || shiftBypass)
        return p;
    return snapPoint(p, gridStep());
}
function updateGridTicking() {
    const step = gridStep();
    layout.xaxis.dtick = step;
    layout.yaxis.dtick = step;
}
// ------- Rendering -------
function redraw() {
    var _a, _b, _c;
    // Ensure grid dtick reflects current snap settings
    updateGridTicking();
    const sorted = points.slice().sort((a, b) => a.x - b.x);
    const auto = computeAutoTangents(sorted, 0);
    const curveXs = [];
    const curveYs = [];
    for (let i = 0; i + 1 < sorted.length; i++) {
        const p0 = sorted[i];
        const p1 = sorted[i + 1];
        const m0 = p0.tx !== undefined && p0.ty !== undefined ? { x: p0.tx, y: p0.ty } : (_a = auto[p0.id]) !== null && _a !== void 0 ? _a : { x: 0, y: 0 };
        const m1 = p1.tx !== undefined && p1.ty !== undefined ? { x: p1.tx, y: p1.ty } : (_b = auto[p1.id]) !== null && _b !== void 0 ? _b : { x: 0, y: 0 };
        const m0c = clampHandleMagnitude({ x: p0.x, y: p0.y }, { x: p1.x, y: p1.y }, m0);
        const m1c = clampHandleMagnitude({ x: p0.x, y: p0.y }, { x: p1.x, y: p1.y }, m1);
        const steps = splineToggle.checked ? 48 : 2;
        const seg = sampleHermiteSegment({ x: p0.x, y: p0.y }, { x: p1.x, y: p1.y }, m0c, m1c, steps);
        const startIdx = (i === 0) ? 0 : 1;
        for (let k = startIdx; k < seg.length; k++) {
            curveXs.push(seg[k].x);
            curveYs.push(seg[k].y);
        }
    }
    const markerXs = sorted.map(p => p.x);
    const markerYs = sorted.map(p => p.y);
    const showHandles = !!editTangents.checked;
    const handleXs = [];
    const handleYs = [];
    const linkXs = [];
    const linkYs = [];
    if (showHandles) {
        for (const p of sorted) {
            const tVec = (p.tx !== undefined && p.ty !== undefined) ? { x: p.tx, y: p.ty } : (_c = auto[p.id]) !== null && _c !== void 0 ? _c : { x: 0, y: 0 };
            const hx = p.x + tVec.x;
            const hy = p.y + tVec.y;
            handleXs.push(hx);
            handleYs.push(hy);
            linkXs.push(p.x, hx, NaN);
            linkYs.push(p.y, hy, NaN);
        }
    }
    Plotly.react(plotDiv, [
        Object.assign(Object.assign({}, traceCurve), { x: curveXs, y: curveYs }),
        Object.assign(Object.assign({}, traceMarkers), { x: markerXs, y: markerYs }),
        Object.assign(Object.assign({}, traceHandleLinks), { x: linkXs, y: linkYs, visible: showHandles }),
        Object.assign(Object.assign({}, traceHandles), { x: handleXs, y: handleYs, visible: showHandles }),
    ], layout);
    // Render editable list below
    renderPointsPanel(sorted, auto);
}
// ------- Coordinate conversion & picking -------
function eventToDataCoords(ev) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    const full = plotDiv._fullLayout;
    if (!full || !full.xaxis || !full.yaxis)
        return null;
    const rect = plotDiv.getBoundingClientRect();
    const xPixel = ev.clientX - rect.left;
    const yPixel = ev.clientY - rect.top;
    const leftPad = (_c = (_a = full.l) !== null && _a !== void 0 ? _a : (_b = full.margin) === null || _b === void 0 ? void 0 : _b.l) !== null && _c !== void 0 ? _c : 0;
    const topPad = (_f = (_d = full.t) !== null && _d !== void 0 ? _d : (_e = full.margin) === null || _e === void 0 ? void 0 : _e.t) !== null && _f !== void 0 ? _f : 0;
    const innerX = xPixel - leftPad;
    const innerY = yPixel - topPad;
    const w = (_g = full._size) === null || _g === void 0 ? void 0 : _g.w;
    const h = (_h = full._size) === null || _h === void 0 ? void 0 : _h.h;
    if (typeof w !== "number" || typeof h !== "number")
        return null;
    if (innerX < 0 || innerY < 0 || innerX > w || innerY > h)
        return null;
    const pxToX = (_j = full.xaxis.p2c) !== null && _j !== void 0 ? _j : full.xaxis.p2l;
    const pxToY = (_k = full.yaxis.p2c) !== null && _k !== void 0 ? _k : full.yaxis.p2l;
    if (typeof pxToX !== "function" || typeof pxToY !== "function")
        return null;
    const x = pxToX(innerX);
    const y = pxToY(innerY);
    return (typeof x === "number" && typeof y === "number") ? { x, y } : null;
}
function currentAutoTangents() {
    const sorted = points.slice().sort((a, b) => a.x - b.x);
    return computeAutoTangents(sorted, 0);
}
// Find nearest handle to mouse in data units
function findNearestHandle(mouse, tol = HANDLE_TOL) {
    var _a;
    const auto = currentAutoTangents();
    let best = null;
    for (const p of points) {
        const tVec = (p.tx !== undefined && p.ty !== undefined) ? { x: p.tx, y: p.ty } : (_a = auto[p.id]) !== null && _a !== void 0 ? _a : { x: 0, y: 0 };
        const hx = p.x + tVec.x;
        const hy = p.y + tVec.y;
        const d = Math.hypot(mouse.x - hx, mouse.y - hy);
        if (best === null || d < best.dist)
            best = { id: p.id, dist: d };
    }
    return (best && best.dist <= tol) ? best : null;
}
// Find nearest point to mouse in data units
function findNearestPoint(mouse, tol = POINT_TOL) {
    let best = null;
    for (const p of points) {
        const d = Math.hypot(mouse.x - p.x, mouse.y - p.y);
        if (best === null || d < best.dist)
            best = { id: p.id, dist: d };
    }
    return (best && best.dist <= tol) ? best : null;
}
// ------- Deletion helpers -------
function deleteNearestPoint(mouse, tol = POINT_TOL) {
    const pick = findNearestPoint(mouse, tol);
    if (!pick)
        return false;
    points = points.filter(pt => pt.id !== pick.id);
    return true;
}
function clearNearestHandle(mouse, tol = HANDLE_TOL) {
    const pick = findNearestHandle(mouse, tol);
    if (!pick)
        return false;
    const p = points.find(pt => pt.id === pick.id);
    if (!p)
        return false;
    p.tx = undefined;
    p.ty = undefined;
    return true;
}
// Sample Hermite segment between p0 and p1 with tangents m0, m1
function sampleHermiteSegment(p0, p1, m0, m1, steps = 32) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const b0 = H00(t), b1 = H10(t), b2 = H01(t), b3 = H11(t);
        const p = add(add(mul(p0, b0), mul(m0, b1)), add(mul(p1, b2), mul(m1, b3)));
        pts.push(p);
    }
    return pts;
}
// ------- Interactions (Pointer Events) -------
plotDiv.addEventListener("pointerdown", (ev) => {
    isPointerDown = true;
    dragDistanceSq = 0;
    lastPointerPos = { x: ev.clientX, y: ev.clientY };
    const dataPos = eventToDataCoords(ev);
    if (!dataPos)
        return;
    if (editTangents.checked) {
        const h = findNearestHandle(dataPos, HANDLE_TOL);
        const p = findNearestPoint(dataPos, POINT_TOL);
        let picked = null;
        if (h && p)
            picked = (h.dist <= p.dist) ? "handle" : "point";
        else if (h)
            picked = "handle";
        else if (p)
            picked = "point";
        if (picked === "handle" && h) {
            draggingHandlePointId = h.id;
        }
        else if (picked === "point" && p) {
            draggingPointId = p.id;
        }
        if (picked) {
            plotDiv.setPointerCapture(ev.pointerId);
            ev.preventDefault();
        }
    }
});
plotDiv.addEventListener("pointermove", (ev) => {
    if (!isPointerDown)
        return;
    if (lastPointerPos) {
        const dx = ev.clientX - lastPointerPos.x;
        const dy = ev.clientY - lastPointerPos.y;
        dragDistanceSq += dx * dx + dy * dy;
        lastPointerPos = { x: ev.clientX, y: ev.clientY };
    }
    const mouse = eventToDataCoords(ev);
    if (!mouse)
        return;
    const shiftBypass = !!ev.shiftKey;
    // Dragging a handle
    if (draggingHandlePointId !== null) {
        const p = points.find(pt => pt.id === draggingHandlePointId);
        if (!p)
            return;
        const target = snapIfEnabled(mouse, shiftBypass);
        let h = { x: target.x - p.x, y: target.y - p.y };
        const sorted = points.slice().sort((a, b) => a.x - b.x);
        const idx = sorted.findIndex(s => s.id === p.id);
        const left = idx > 0 ? sorted[idx - 1] : null;
        const right = idx < sorted.length - 1 ? sorted[idx + 1] : null;
        let ref = null;
        if (left && right) {
            const dl = Math.hypot(p.x - left.x, p.y - left.y);
            const dr = Math.hypot(right.x - p.x, right.y - p.y);
            ref = (dl >= dr) ? { x: left.x, y: left.y } : { x: right.x, y: right.y };
        }
        else if (left)
            ref = { x: left.x, y: left.y };
        else if (right)
            ref = { x: right.x, y: right.y };
        if (ref)
            h = clampHandleMagnitude({ x: p.x, y: p.y }, ref, h);
        p.tx = h.x;
        p.ty = h.y;
        redraw();
        return;
    }
    // Dragging a point
    if (draggingPointId !== null) {
        const p = points.find(pt => pt.id === draggingPointId);
        if (!p)
            return;
        const snapped = snapIfEnabled(mouse, shiftBypass);
        p.x = snapped.x;
        p.y = snapped.y;
        redraw();
    }
});
plotDiv.addEventListener("pointerup", (ev) => {
    isPointerDown = false;
    lastPointerPos = null;
    const DRAG_SUPPRESS_THRESHOLD_SQ = 25; // ~5px
    if (dragDistanceSq >= DRAG_SUPPRESS_THRESHOLD_SQ) {
        suppressNextClick = true;
    }
    dragDistanceSq = 0;
    draggingHandlePointId = null;
    draggingPointId = null;
    try {
        plotDiv.releasePointerCapture(ev.pointerId);
    }
    catch (_a) { }
});
plotDiv.addEventListener("click", (ev) => {
    if (suppressNextClick) {
        suppressNextClick = false;
        return;
    }
    const mouse = eventToDataCoords(ev);
    if (!mouse)
        return;
    // Alt+Click deletion first (works in any mode)
    if (ev.altKey) {
        const deletedPoint = deleteNearestPoint(mouse, POINT_TOL);
        if (!deletedPoint && editTangents.checked) {
            const clearedHandle = clearNearestHandle(mouse, HANDLE_TOL);
            if (clearedHandle)
                redraw();
            return;
        }
        if (deletedPoint) {
            redraw();
            return;
        }
        return;
    }
    // Add point (only when not editing tangents)
    if (editTangents.checked)
        return;
    const snapped = snapIfEnabled(mouse, !!ev.shiftKey);
    points.push({ id: nextId++, x: snapped.x, y: snapped.y });
    redraw();
});
// ------- Points Panel (editable list) -------
function deg(rad) { return rad * (180 / Math.PI); }
function rad(degVal) { return degVal * (Math.PI / 180); }
function neighborsOf(p) {
    const sorted = points.slice().sort((a, b) => a.x - b.x);
    const idx = sorted.findIndex(s => s.id === p.id);
    return {
        left: idx > 0 ? sorted[idx - 1] : null,
        right: idx < sorted.length - 1 ? sorted[idx + 1] : null,
    };
}
function clampManualHandleFor(p, h) {
    const { left, right } = neighborsOf(p);
    let ref = null;
    if (left && right) {
        const dl = Math.hypot(p.x - left.x, p.y - left.y);
        const dr = Math.hypot(right.x - p.x, right.y - p.y);
        ref = (dl >= dr) ? { x: left.x, y: left.y } : { x: right.x, y: right.y };
    }
    else if (left)
        ref = { x: left.x, y: left.y };
    else if (right)
        ref = { x: right.x, y: right.y };
    return ref ? clampHandleMagnitude({ x: p.x, y: p.y }, ref, h) : h;
}
function renderPointsPanel(sorted, auto) {
    const rows = sorted.map((p, idx) => {
        var _a;
        const isManual = p.tx !== undefined && p.ty !== undefined;
        const t = isManual ? { x: p.tx, y: p.ty } : ((_a = auto[p.id]) !== null && _a !== void 0 ? _a : { x: 0, y: 0 });
        const angleDeg = deg(Math.atan2(t.y, t.x));
        const mag = Math.hypot(t.x, t.y);
        // Disable inputs when tangent is auto
        const disabled = isManual ? "" : "disabled";
        return `
      <tr>
        <td>${idx + 1}</td>
        <td><input type="number" step="0.05" value="${p.x.toFixed(3)}" data-id="${p.id}" data-role="x" /></td>
        <td><input type="number" step="0.05" value="${p.y.toFixed(3)}" data-id="${p.id}" data-role="y" /></td>

        <td>
          <label>
            <input type="checkbox" ${isManual ? "checked" : ""} data-id="${p.id}" data-role="manual" />
            Manual
          </label>
        </td>

        <td><input class="small" type="number" step="1" value="${angleDeg.toFixed(1)}" ${disabled} data-id="${p.id}" data-role="angle" />°</td>
        <td><input class="small" type="number" step="0.05" value="${mag.toFixed(3)}" ${disabled} data-id="${p.id}" data-role="mag" /></td>
        <td><input type="number" step="0.05" value="${t.x.toFixed(3)}" ${disabled} data-id="${p.id}" data-role="tx" /></td>
        <td><input type="number" step="0.05" value="${t.y.toFixed(3)}" ${disabled} data-id="${p.id}" data-role="ty" /></td>

        <td class="actions">
          <button data-id="${p.id}" data-role="clear">Clear tangent</button>
          <button data-id="${p.id}" data-role="delete">Delete point</button>
        </td>
      </tr>
    `;
    }).join("");
    pointsPanel.innerHTML = `
    <table class="points">
      <thead>
        <tr>
          <th>#</th>
          <th>X</th>
          <th>Y</th>
          <th>Tangent</th>
          <th>Angle</th>
          <th>Magnitude</th>
          <th>TX</th>
          <th>TY</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="9" style="text-align:center;color:#777;">No points yet</td></tr>`}
      </tbody>
    </table>
  `;
}
// Delegate input changes from the panel
pointsPanel.addEventListener("change", (ev) => {
    var _a, _b, _c, _d;
    const target = ev.target;
    const role = (_a = target === null || target === void 0 ? void 0 : target.dataset) === null || _a === void 0 ? void 0 : _a.role;
    const id = parseInt(((_b = target === null || target === void 0 ? void 0 : target.dataset) === null || _b === void 0 ? void 0 : _b.id) || "", 10);
    if (!role || Number.isNaN(id))
        return;
    const p = points.find(pt => pt.id === id);
    if (!p)
        return;
    if (target.value === "") {
        target.value = "0";
    }
    const val = parseFloat(target.value);
    if (role === "x") {
        const snapped = snapIfEnabled({ x: val, y: p.y }, false);
        p.x = snapped.x;
        redraw();
        return;
    }
    if (role === "y") {
        const snapped = snapIfEnabled({ x: p.x, y: val }, false);
        p.y = snapped.y;
        redraw();
        return;
    }
    // Ensure manual tangent is enabled when editing tangent fields
    const ensureManual = () => {
        var _a;
        if (p.tx === undefined || p.ty === undefined) {
            const auto = currentAutoTangents();
            const t0 = (_a = auto[p.id]) !== null && _a !== void 0 ? _a : { x: 0, y: 0 };
            p.tx = t0.x;
            p.ty = t0.y;
        }
    };
    if (role === "tx") {
        ensureManual();
        let h = clampManualHandleFor(p, { x: val, y: (_c = p.ty) !== null && _c !== void 0 ? _c : 0 });
        // Apply snap to handle endpoint (point + vector)
        const endpoint = snapIfEnabled({ x: p.x + h.x, y: p.y + h.y }, false);
        p.tx = endpoint.x - p.x;
        p.ty = endpoint.y - p.y;
        redraw();
        return;
    }
    if (role === "ty") {
        ensureManual();
        let h = clampManualHandleFor(p, { x: (_d = p.tx) !== null && _d !== void 0 ? _d : 0, y: val });
        const endpoint = snapIfEnabled({ x: p.x + h.x, y: p.y + h.y }, false);
        p.tx = endpoint.x - p.x;
        p.ty = endpoint.y - p.y;
        redraw();
        return;
    }
    if (role === "angle") {
        ensureManual();
        const curMag = Math.hypot(p.tx, p.ty);
        const ang = rad(val); // degrees -> radians
        let h = { x: curMag * Math.cos(ang), y: curMag * Math.sin(ang) };
        h = clampManualHandleFor(p, h);
        const endpoint = snapIfEnabled({ x: p.x + h.x, y: p.y + h.y }, false);
        p.tx = endpoint.x - p.x;
        p.ty = endpoint.y - p.y;
        redraw();
        return;
    }
    if (role === "mag") {
        ensureManual();
        const curAng = Math.atan2(p.ty, p.tx);
        let h = { x: val * Math.cos(curAng), y: val * Math.sin(curAng) };
        h = clampManualHandleFor(p, h);
        const endpoint = snapIfEnabled({ x: p.x + h.x, y: p.y + h.y }, false);
        p.tx = endpoint.x - p.x;
        p.ty = endpoint.y - p.y;
        redraw();
        return;
    }
});
// Delegate clicks (manual toggle, clear tangent, delete point)
pointsPanel.addEventListener("click", (ev) => {
    var _a, _b, _c;
    const target = ev.target;
    const role = (_a = target === null || target === void 0 ? void 0 : target.dataset) === null || _a === void 0 ? void 0 : _a.role;
    const id = parseInt(((_b = target === null || target === void 0 ? void 0 : target.dataset) === null || _b === void 0 ? void 0 : _b.id) || "", 10);
    if (!role || Number.isNaN(id))
        return;
    const p = points.find(pt => pt.id === id);
    if (!p)
        return;
    if (role === "manual") {
        const input = target;
        if (input.checked) {
            // enable manual: seed from auto
            const auto = currentAutoTangents();
            const t0 = (_c = auto[p.id]) !== null && _c !== void 0 ? _c : { x: 0, y: 0 };
            p.tx = t0.x;
            p.ty = t0.y;
        }
        else {
            // disable: return to auto
            p.tx = undefined;
            p.ty = undefined;
        }
        redraw();
        return;
    }
    if (role === "clear") {
        p.tx = undefined;
        p.ty = undefined;
        redraw();
        return;
    }
    if (role === "delete") {
        points = points.filter(pt => pt.id !== id);
        redraw();
        return;
    }
});
// ------- Controls -------
resetBtn.addEventListener("click", () => {
    points = [];
    nextId = 1;
    redraw();
});
splineToggle.addEventListener("change", redraw);
editTangents.addEventListener("change", () => {
    redraw();
});
snapGrid.addEventListener("change", () => {
    gridStepValue.textContent = gridStep().toFixed(2);
    redraw();
});
gridStepInput.addEventListener("input", () => {
    gridStepValue.textContent = gridStep().toFixed(2);
    redraw();
});
// Initial render
gridStepValue.textContent = gridStep().toFixed(2);
redraw();
/** Sample the current Hermite curve at N points per segment. */
function sampleCurvePoints(stepsPerSeg) {
    var _a, _b;
    const sorted = points.slice().sort((a, b) => a.x - b.x);
    const auto = computeAutoTangents(sorted, 0);
    const out = [];
    for (let i = 0; i + 1 < sorted.length; i++) {
        const p0 = sorted[i], p1 = sorted[i + 1];
        const m0 = p0.tx !== undefined && p0.ty !== undefined ? { x: p0.tx, y: p0.ty } : (_a = auto[p0.id]) !== null && _a !== void 0 ? _a : { x: 0, y: 0 };
        const m1 = p1.tx !== undefined && p1.ty !== undefined ? { x: p1.tx, y: p1.ty } : (_b = auto[p1.id]) !== null && _b !== void 0 ? _b : { x: 0, y: 0 };
        const m0c = clampHandleMagnitude({ x: p0.x, y: p0.y }, { x: p1.x, y: p1.y }, m0);
        const m1c = clampHandleMagnitude({ x: p0.x, y: p0.y }, { x: p1.x, y: p1.y }, m1);
        const seg = sampleHermiteSegment({ x: p0.x, y: p0.y }, { x: p1.x, y: p1.y }, m0c, m1c, stepsPerSeg);
        const startIdx = (i === 0) ? 0 : 1; // avoid duplicating the join point
        for (let k = startIdx; k < seg.length; k++)
            out.push({ x: seg[k].x, y: seg[k].y });
    }
    return out;
}
/** Format list literal: {(x1,y1),(x2,y2),...} with fixed decimals. */
function toGeogebraListLiteral(pts, decimals = 6) {
    const fmt = (v) => Number.isFinite(v) ? v.toFixed(decimals) : "NaN";
    return "{ " + pts.map(p => `(${fmt(p.x)},${fmt(p.y)})`).join(", ") + " }";
}
/** Build Polyline command: list + polyline. */
function makeGeogebraPolyline(samplesPerSeg = 48) {
    const pts = sampleCurvePoints(samplesPerSeg);
    const list = toGeogebraListLiteral(pts);
    return `Polyline(${list})`;
}
/** Build Spline command through clicked (sorted) points; optional order / weight. */
function makeGeogebraSpline(order = null, weight = "default") {
    const sorted = points.slice().sort((a, b) => a.x - b.x).map(p => ({ x: p.x, y: p.y }));
    const list = toGeogebraListLiteral(sorted);
    const weightExpr = weight === "absx" ? "abs(x)+0*y" : "sqrt(x^2+y^2)";
    if (order && order >= 3) {
        return [
            `list1 = ${list}`,
            `spl = Spline(list1, ${order}, ${weightExpr})`
        ].join("\n");
    }
    return [
        `list1 = ${list}`,
        `spl = Spline(list1)`
    ].join("\n");
}
/** Build piecewise Hermite parametric Curve(x(t), y(t), t, 0, 1) with If(...) pieces. */
function makeGeogebraParametric() {
    var _a, _b;
    const sorted = points.slice().sort((a, b) => a.x - b.x);
    const auto = computeAutoTangents(sorted, 0);
    const nSeg = Math.max(0, sorted.length - 1);
    if (nSeg === 0)
        return "// Add at least two points";
    const coefsX = [];
    const coefsY = [];
    for (let i = 0; i < nSeg; i++) {
        const p0 = sorted[i], p1 = sorted[i + 1];
        const m0 = p0.tx !== undefined && p0.ty !== undefined ? { x: p0.tx, y: p0.ty } : (_a = auto[p0.id]) !== null && _a !== void 0 ? _a : { x: 0, y: 0 };
        const m1 = p1.tx !== undefined && p1.ty !== undefined ? { x: p1.tx, y: p1.ty } : (_b = auto[p1.id]) !== null && _b !== void 0 ? _b : { x: 0, y: 0 };
        const axX = 2 * p0.x - 2 * p1.x + m0.x + m1.x;
        const bxX = -3 * p0.x + 3 * p1.x - 2 * m0.x - m1.x;
        const cxX = m0.x;
        const dxX = p0.x;
        const axY = 2 * p0.y - 2 * p1.y + m0.y + m1.y;
        const bxY = -3 * p0.y + 3 * p1.y - 2 * m0.y - m1.y;
        const cxY = m0.y;
        const dxY = p0.y;
        coefsX.push({ ax: axX, bx: bxX, cx: cxX, dx: dxX });
        coefsY.push({ ax: axY, bx: bxY, cx: cxY, dx: dxY });
    }
    // Compose If(...) chains over t in [0,1]; local s = nSeg*t - i
    const D = 8; // decimals
    const fmt = (v) => Number.isFinite(v) ? v.toFixed(D) : "NaN";
    const pieceX = [];
    const pieceY = [];
    for (let i = 0; i < nSeg; i++) {
        const s = `( ${nSeg} * t - ${i} )`;
        const cond = i < nSeg - 1 ? `(t < ${(i + 1) / nSeg})` : null;
        const c = coefsX[i];
        const exprX = `${fmt(c.ax)}*(${s})^3 + ${fmt(c.bx)}*(${s})^2 + ${fmt(c.cx)}*(${s}) + ${fmt(c.dx)}`;
        const d = coefsY[i];
        const exprY = `${fmt(d.ax)}*(${s})^3 + ${fmt(d.bx)}*(${s})^2 + ${fmt(d.cx)}*(${s}) + ${fmt(d.dx)}`;
        pieceX.push(cond ? `If${cond ? `(${cond}, ${exprX}, ` : ""}` : exprX);
        pieceY.push(cond ? `If${cond ? `(${cond}, ${exprY}, ` : ""}` : exprY);
    }
    // Close nested If(...) chains by appending final expressions and ')' brackets
    const closeIfs = (arr) => {
        let out = "";
        for (let i = 0; i < arr.length; i++) {
            if (i < arr.length - 1)
                out += arr[i];
            else
                out += arr[i]; // last piece is the "else"
        }
        // add closing parentheses: one ')' per 'If(' used
        const ifCount = arr.length - 1;
        out += ")".repeat(ifCount);
        return out;
    };
    const xExpr = closeIfs(pieceX);
    const yExpr = closeIfs(pieceY);
    return `Curve( ${xExpr}, ${yExpr}, t, 0, 1 )`;
}
/** CSV blob of sampled points: columns x,y with header. */
function makeCSV(samplesPerSeg = 48) {
    const pts = sampleCurvePoints(samplesPerSeg);
    const lines = ["x,y", ...pts.map(p => `${p.x},${p.y}`)];
    return lines.join("\n");
}
/** Utils: copy to clipboard & download text file */
function copyToClipboard(text) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            yield navigator.clipboard.writeText(text);
        }
        catch (_a) { }
    });
}
function downloadTextFile(text, filename) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}
// ---------- Wire export panel ----------
const btnExportPolyline = document.getElementById("btnExportPolyline");
const btnExportSpline = document.getElementById("btnExportSpline");
const btnExportParam = document.getElementById("btnExportParam");
const btnDownloadCSV = document.getElementById("btnDownloadCSV");
const samplesPerSegment = document.getElementById("samplesPerSegment");
const ggbOut = document.getElementById("ggbOut");
function currentSamples() {
    const n = parseInt(samplesPerSegment.value || "48", 10);
    return Number.isFinite(n) && n >= 2 ? n : 48;
}
btnExportPolyline.addEventListener("click", () => __awaiter(void 0, void 0, void 0, function* () {
    const script = makeGeogebraPolyline(currentSamples());
    ggbOut.value = script;
    yield copyToClipboard(script);
}));
btnExportSpline.addEventListener("click", () => __awaiter(void 0, void 0, void 0, function* () {
    // Default: cubic (order omitted) and GeoGebra’s default weight sqrt(x^2+y^2)
    const script = makeGeogebraSpline(null, "default");
    ggbOut.value = script;
    yield copyToClipboard(script);
}));
btnExportParam.addEventListener("click", () => __awaiter(void 0, void 0, void 0, function* () {
    const script = makeGeogebraParametric();
    ggbOut.value = script;
    yield copyToClipboard(script);
}));
btnDownloadCSV.addEventListener("click", () => {
    const csv = makeCSV(currentSamples());
    downloadTextFile(csv, "curve_points.csv");
});
