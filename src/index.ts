
// Assume Plotly is globally available from CDN
declare const Plotly: any;

type Point = {
    id: number;
    x: number;
    y: number;
    // Manual tangent vector (in data units). If undefined, auto tangent is used.
    tx?: number;
    ty?: number;
};

type Vec = { x: number; y: number };

const plotDiv = document.getElementById("plot") as HTMLDivElement;
const pointsPanel = document.getElementById("pointsPanel") as HTMLDivElement;

const resetBtn = document.getElementById("resetBtn") as HTMLButtonElement;
const splineToggle = document.getElementById("splineToggle") as HTMLInputElement;
const editTangents = document.getElementById("editTangents") as HTMLInputElement;
const tensionValue = document.getElementById("tensionValue") as HTMLSpanElement;

const snapGrid = document.getElementById("snapGrid") as HTMLInputElement;
const gridStepInput = document.getElementById("gridStep") as HTMLInputElement;
const gridStepValue = document.getElementById("gridStepValue") as HTMLSpanElement;

let points: Point[] = [];
let nextId = 1;

// ---- Drag state ----
let draggingHandlePointId: number | null = null;
let draggingPointId: number | null = null;

// For click-suppression after a drag (works for mouse/touch/pen)
let isPointerDown = false;
let dragDistanceSq = 0;
let lastPointerPos: { x: number; y: number } | null = null;
let suppressNextClick = false;

// Picking tolerances (in data units; adjust to taste)
const HANDLE_TOL = 0.5;
const POINT_TOL = 0.4;

// ------- Plotly setup -------
const layout: any = {
    margin: { l: 50, r: 20, t: 30, b: 50 },
    hovermode: false,
    xaxis: { tickmode: "linear", dtick: 1, showgrid: true, range: [-10, 10], gridcolor: "#eee" },
    yaxis: { tickmode: "linear", dtick: 1, showgrid: true, range: [-10, 10], gridcolor: "#eee" },
    gridwidth:1,
    showgrid: true,
    showlegend: false,
    dragmode: "pan",
    //width: plotDiv.clientWidth,
    //height: plotDiv.clientWidth,
};

const traceCurve: any = {
    x: [],
    y: [],
    mode: "lines",
    line: { color: "#ff7f0e", width: 3 }, // custom Hermite curve
    name: "Curve",
};

const traceMarkers: any = {
    x: [],
    y: [],
    mode: "markers",
    marker: { color: "#1f77b4", size: 8 },
    name: "Points",
};

const traceHandles: any = {
    x: [],
    y: [],
    mode: "markers",
    marker: { color: "#ff7f0e", size: 8, symbol: "square" },
    name: "Handles",
    visible: true,
};

const traceHandleLinks: any = {
    x: [],
    y: [],
    mode: "lines",
    line: { color: "#ff7f0e", width: 1, dash: "dot" },
    name: "Handle Links",
    visible: true,
};

const config = {
    displayModeBar: true,
    scrollZoom: true,         // no wheel zoom
    doubleClick: false,       // no double-click autoscale
    modeBarButtonsToRemove: [
        'zoom2d', 'pan2d', 'select2d', 'lasso2d',
        'zoomIn2d', 'zoomOut2d', 'autoScale2d', 'resetScale2d'
    ],
    responsive: true,
};

Plotly.newPlot(plotDiv, [traceCurve, traceMarkers, traceHandleLinks, traceHandles], layout, config);

// ------- Math helpers -------

function H00(t: number) { return 2*t*t*t - 3*t*t + 1; }
function H10(t: number) { return t*t*t - 2*t*t + t; }
function H01(t: number) { return -2*t*t*t + 3*t*t; }
function H11(t: number) { return t*t*t - t*t; }

function add(a: Vec, b: Vec): Vec { return { x: a.x + b.x, y: a.y + b.y }; }
function mul(a: Vec, s: number): Vec { return { x: a.x * s, y: a.y * s }; }
function sub(a: Vec, b: Vec): Vec { return { x: a.x - b.x, y: a.y - b.y }; }
function len(a: Vec): number { return Math.hypot(a.x, a.y); }

function clampHandleMagnitude(p0: Vec, p1: Vec, h: Vec): Vec {
    const chord = len(sub(p1, p0));
    const maxMag = Math.max(0.0001, 1.5 * chord);
    const mag = len(h);
    if (mag <= maxMag) return h;
    const s = maxMag / mag;
    return mul(h, s);
}

// Compute auto tangents (Catmull-Rom style) for points sorted by x.
function computeAutoTangents(sorted: Point[], tension: number): Record<number, Vec> {
    const m: Record<number, Vec> = {};
    const n = sorted.length;
    const l = 5;

    for (let i = 0; i < n; i++) {
        const p = sorted[i];
        let tangent: Vec = { x: 0, y: 0 };

        if (n === 1) {
            tangent = { x: 0, y: 0 };
        } else if (i === 0) {
            const p1 = sorted[i + 1];
            tangent = { x: 5, y: 0 };
        } else if (i === n - 1) {
            const pm1 = sorted[i - 1];
            tangent = { x: 5, y: 0 };
        } else {
            const pNext = sorted[i + 1];
            const pPrev = sorted[i - 1];
            tangent = { x: 5, y: 0 };
        }

        m[p.id] = tangent;
    }

    return m;
}

// ------- Grid snapping -------

function gridStep(): number {
    const v = parseFloat(gridStepInput.value);
    return isFinite(v) && v > 0 ? v : 0.5;
}

function snapVal(v: number, step: number): number {
    return Math.round(v / step) * step;
}

function snapPoint(p: Vec, step: number): Vec {
    return { x: snapVal(p.x, step), y: snapVal(p.y, step) };
}

function snapIfEnabled(p: Vec, shiftBypass: boolean): Vec {
    if (!snapGrid.checked || shiftBypass) return p;
    return snapPoint(p, gridStep());
}

function updateGridTicking() {
    const step = gridStep();
    layout.xaxis.dtick = step;
    layout.yaxis.dtick = step;
}

// ------- Rendering -------

function redraw() {
    // Ensure grid dtick reflects current snap settings
    updateGridTicking();

    const sorted = points.slice().sort((a, b) => a.x - b.x);

    const auto = computeAutoTangents(sorted, 0);

    const curveXs: number[] = [];
    const curveYs: number[] = [];

    for (let i = 0; i + 1 < sorted.length; i++) {
        const p0 = sorted[i];
        const p1 = sorted[i + 1];

        const m0 = p0.tx !== undefined && p0.ty !== undefined ? { x: p0.tx, y: p0.ty } : auto[p0.id] ?? { x: 0, y: 0 };
        const m1 = p1.tx !== undefined && p1.ty !== undefined ? { x: p1.tx, y: p1.ty } : auto[p1.id] ?? { x: 0, y: 0 };

        const m0c = clampHandleMagnitude({ x: p0.x, y: p0.y }, { x: p1.x, y: p1.y }, m0);
        const m1c = clampHandleMagnitude({ x: p0.x, y: p0.y }, { x: p1.x, y: p1.y }, m1);

        const steps = splineToggle.checked ? 48 : 2;
        const seg = sampleHermiteSegment(
            { x: p0.x, y: p0.y },
            { x: p1.x, y: p1.y },
            m0c, m1c,
            steps
        );

        const startIdx = (i === 0) ? 0 : 1;
        for (let k = startIdx; k < seg.length; k++) {
            curveXs.push(seg[k].x);
            curveYs.push(seg[k].y);
        }
    }

    const markerXs = sorted.map(p => p.x);
    const markerYs = sorted.map(p => p.y);

    const showHandles = !!editTangents.checked;
    const handleXs: number[] = [];
    const handleYs: number[] = [];
    const linkXs: number[] = [];
    const linkYs: number[] = [];

    if (showHandles) {
        for (const p of sorted) {
            const tVec = (p.tx !== undefined && p.ty !== undefined) ? { x: p.tx!, y: p.ty! } : auto[p.id] ?? { x: 0, y: 0 };
            const hx = p.x + tVec.x;
            const hy = p.y + tVec.y;
            handleXs.push(hx);
            handleYs.push(hy);
            linkXs.push(p.x, hx, NaN);
            linkYs.push(p.y, hy, NaN);
        }
    }

    Plotly.react(plotDiv, [
        { ...traceCurve, x: curveXs, y: curveYs },
        { ...traceMarkers, x: markerXs, y: markerYs },
        { ...traceHandleLinks, x: linkXs, y: linkYs, visible: showHandles },
        { ...traceHandles, x: handleXs, y: handleYs, visible: showHandles },
    ], layout);

    // Render editable list below
    renderPointsPanel(sorted, auto);
}

// ------- Coordinate conversion & picking -------

function eventToDataCoords(ev: MouseEvent | PointerEvent): Vec | null {
    const full = (plotDiv as any)._fullLayout;
    if (!full || !full.xaxis || !full.yaxis) return null;

    const rect = plotDiv.getBoundingClientRect();
    const xPixel = ev.clientX - rect.left;
    const yPixel = ev.clientY - rect.top;

    const leftPad = full.l ?? full.margin?.l ?? 0;
    const topPad = full.t ?? full.margin?.t ?? 0;

    const innerX = xPixel - leftPad;
    const innerY = yPixel - topPad;

    const w = full._size?.w;
    const h = full._size?.h;
    if (typeof w !== "number" || typeof h !== "number") return null;
    if (innerX < 0 || innerY < 0 || innerX > w || innerY > h) return null;

    const pxToX = full.xaxis.p2c ?? full.xaxis.p2l;
    const pxToY = full.yaxis.p2c ?? full.yaxis.p2l;
    if (typeof pxToX !== "function" || typeof pxToY !== "function") return null;

    const x = pxToX(innerX);
    const y = pxToY(innerY);
    return (typeof x === "number" && typeof y === "number") ? { x, y } : null;
}

function currentAutoTangents(): Record<number, Vec> {
    const sorted = points.slice().sort((a, b) => a.x - b.x);
    return computeAutoTangents(sorted, 0);
}

// Find nearest handle to mouse in data units
function findNearestHandle(mouse: Vec, tol = HANDLE_TOL): { id: number; dist: number } | null {
    const auto = currentAutoTangents();
    let best: { id: number; dist: number } | null = null;

    for (const p of points) {
        const tVec = (p.tx !== undefined && p.ty !== undefined) ? { x: p.tx!, y: p.ty! } : auto[p.id] ?? { x: 0, y: 0 };
        const hx = p.x + tVec.x;
        const hy = p.y + tVec.y;
        const d = Math.hypot(mouse.x - hx, mouse.y - hy);
        if (best === null || d < best.dist) best = { id: p.id, dist: d };
    }

    return (best && best.dist <= tol) ? best : null;
}

// Find nearest point to mouse in data units
function findNearestPoint(mouse: Vec, tol = POINT_TOL): { id: number; dist: number } | null {
    let best: { id: number; dist: number } | null = null;
    for (const p of points) {
        const d = Math.hypot(mouse.x - p.x, mouse.y - p.y);
        if (best === null || d < best.dist) best = { id: p.id, dist: d };
    }
    return (best && best.dist <= tol) ? best : null;
}

// ------- Deletion helpers -------

function deleteNearestPoint(mouse: Vec, tol = POINT_TOL): boolean {
    const pick = findNearestPoint(mouse, tol);
    if (!pick) return false;
    points = points.filter(pt => pt.id !== pick.id);
    return true;
}

function clearNearestHandle(mouse: Vec, tol = HANDLE_TOL): boolean {
    const pick = findNearestHandle(mouse, tol);
    if (!pick) return false;
    const p = points.find(pt => pt.id === pick.id);
    if (!p) return false;
    p.tx = undefined;
    p.ty = undefined;
    return true;
}

// Sample Hermite segment between p0 and p1 with tangents m0, m1
function sampleHermiteSegment(p0: Vec, p1: Vec, m0: Vec, m1: Vec, steps = 32): Vec[] {
    const pts: Vec[] = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const b0 = H00(t), b1 = H10(t), b2 = H01(t), b3 = H11(t);
        const p = add(add(mul(p0, b0), mul(m0, b1)), add(mul(p1, b2), mul(m1, b3)));
        pts.push(p);
    }
    return pts;
}

// ------- Interactions (Pointer Events) -------

plotDiv.addEventListener("pointerdown", (ev: PointerEvent) => {
    isPointerDown = true;
    dragDistanceSq = 0;
    lastPointerPos = { x: ev.clientX, y: ev.clientY };

    const dataPos = eventToDataCoords(ev);
    if (!dataPos) return;

    if (editTangents.checked) {
        const h = findNearestHandle(dataPos, HANDLE_TOL);
        const p = findNearestPoint(dataPos, POINT_TOL);

        let picked: "handle" | "point" | null = null;
        if (h && p) picked = (h.dist <= p.dist) ? "handle" : "point";
        else if (h) picked = "handle";
        else if (p) picked = "point";

        if (picked === "handle" && h) {
            draggingHandlePointId = h.id;
        } else if (picked === "point" && p) {
            draggingPointId = p.id;
        }

        if (picked) {
            plotDiv.setPointerCapture(ev.pointerId);
            ev.preventDefault();
        }
    }
});

plotDiv.addEventListener("pointermove", (ev: PointerEvent) => {
    if (!isPointerDown) return;

    if (lastPointerPos) {
        const dx = ev.clientX - lastPointerPos.x;
        const dy = ev.clientY - lastPointerPos.y;
        dragDistanceSq += dx * dx + dy * dy;
        lastPointerPos = { x: ev.clientX, y: ev.clientY };
    }

    const mouse = eventToDataCoords(ev);
    if (!mouse) return;

    const shiftBypass = !!ev.shiftKey;

    // Dragging a handle
    if (draggingHandlePointId !== null) {
        const p = points.find(pt => pt.id === draggingHandlePointId);
        if (!p) return;

        const target = snapIfEnabled(mouse, shiftBypass);
        let h = { x: target.x - p.x, y: target.y - p.y };

        const sorted = points.slice().sort((a, b) => a.x - b.x);
        const idx = sorted.findIndex(s => s.id === p.id);
        const left = idx > 0 ? sorted[idx - 1] : null;
        const right = idx < sorted.length - 1 ? sorted[idx + 1] : null;

        let ref: Vec | null = null;
        if (left && right) {
            const dl = Math.hypot(p.x - left.x, p.y - left.y);
            const dr = Math.hypot(right.x - p.x, right.y - p.y);
            ref = (dl >= dr) ? { x: left.x, y: left.y } : { x: right.x, y: right.y };
        } else if (left) ref = { x: left.x, y: left.y };
        else if (right) ref = { x: right.x, y: right.y };

        if (ref) h = clampHandleMagnitude({ x: p.x, y: p.y }, ref, h);

        p.tx = h.x;
        p.ty = h.y;
        redraw();
        return;
    }

    // Dragging a point
    if (draggingPointId !== null) {
        const p = points.find(pt => pt.id === draggingPointId);
        if (!p) return;

        const snapped = snapIfEnabled(mouse, shiftBypass);
        p.x = snapped.x;
        p.y = snapped.y;
        redraw();
    }
});

plotDiv.addEventListener("pointerup", (ev: PointerEvent) => {
    isPointerDown = false;
    lastPointerPos = null;

    const DRAG_SUPPRESS_THRESHOLD_SQ = 25; // ~5px
    if (dragDistanceSq >= DRAG_SUPPRESS_THRESHOLD_SQ) {
        suppressNextClick = true;
    }
    dragDistanceSq = 0;

    draggingHandlePointId = null;
    draggingPointId = null;

    try { plotDiv.releasePointerCapture(ev.pointerId); } catch {}
});

plotDiv.addEventListener("click", (ev: MouseEvent) => {
    if (suppressNextClick) { suppressNextClick = false; return; }

    const mouse = eventToDataCoords(ev);
    if (!mouse) return;

    // Alt+Click deletion first (works in any mode)
    if (ev.altKey) {
        const deletedPoint = deleteNearestPoint(mouse, POINT_TOL);
        if (!deletedPoint && editTangents.checked) {
            const clearedHandle = clearNearestHandle(mouse, HANDLE_TOL);
            if (clearedHandle) redraw();
            return;
        }
        if (deletedPoint) {
            redraw();
            return;
        }
        return;
    }

    // Add point (only when not editing tangents)
    if (editTangents.checked) return;

    const snapped = snapIfEnabled(mouse, !!ev.shiftKey);
    points.push({ id: nextId++, x: snapped.x, y: snapped.y });
    redraw();
});

// ------- Points Panel (editable list) -------

function deg(rad: number): number { return rad * (180 / Math.PI); }
function rad(degVal: number): number { return degVal * (Math.PI / 180); }

function neighborsOf(p: Point): { left: Point | null; right: Point | null } {
    const sorted = points.slice().sort((a, b) => a.x - b.x);
    const idx = sorted.findIndex(s => s.id === p.id);
    return {
        left: idx > 0 ? sorted[idx - 1] : null,
        right: idx < sorted.length - 1 ? sorted[idx + 1] : null,
    };
}

function clampManualHandleFor(p: Point, h: Vec): Vec {
    const { left, right } = neighborsOf(p);
    let ref: Vec | null = null;
    if (left && right) {
        const dl = Math.hypot(p.x - left.x, p.y - left.y);
        const dr = Math.hypot(right.x - p.x, right.y - p.y);
        ref = (dl >= dr) ? { x: left.x, y: left.y } : { x: right.x, y: right.y };
    } else if (left) ref = { x: left.x, y: left.y };
    else if (right) ref = { x: right.x, y: right.y };

    return ref ? clampHandleMagnitude({ x: p.x, y: p.y }, ref, h) : h;
}

function renderPointsPanel(sorted: Point[], auto: Record<number, Vec>) {
    const rows = sorted.map((p, idx) => {
        const isManual = p.tx !== undefined && p.ty !== undefined;
        const t = isManual ? { x: p.tx!, y: p.ty! } : (auto[p.id] ?? { x: 0, y: 0 });
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

    const target = ev.target as HTMLInputElement;
    const role = target?.dataset?.role;
    const id = parseInt(target?.dataset?.id || "", 10);
    if (!role || Number.isNaN(id)) return;

    const p = points.find(pt => pt.id === id);
    if (!p) return;

    if (target.value === ""){
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
        if (p.tx === undefined || p.ty === undefined) {
            const auto = currentAutoTangents();
            const t0 = auto[p.id] ?? { x: 0, y: 0 };
            p.tx = t0.x; p.ty = t0.y;
        }
    };

    if (role === "tx") {
        ensureManual();
        let h = clampManualHandleFor(p, { x: val, y: p.ty ?? 0 });
        // Apply snap to handle endpoint (point + vector)
        const endpoint = snapIfEnabled({ x: p.x + h.x, y: p.y + h.y }, false);
        p.tx = endpoint.x - p.x;
        p.ty = endpoint.y - p.y;
        redraw();
        return;
    }
    if (role === "ty") {
        ensureManual();
        let h = clampManualHandleFor(p, { x: p.tx ?? 0, y: val });
        const endpoint = snapIfEnabled({ x: p.x + h.x, y: p.y + h.y }, false);
        p.tx = endpoint.x - p.x;
        p.ty = endpoint.y - p.y;
        redraw();
        return;
    }
    if (role === "angle") {
        ensureManual();
        const curMag = Math.hypot(p.tx!, p.ty!);
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
        const curAng = Math.atan2(p.ty!, p.tx!);
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
    const target = ev.target as HTMLElement;
    const role = target?.dataset?.role;
    const id = parseInt(target?.dataset?.id || "", 10);
    if (!role || Number.isNaN(id)) return;

    const p = points.find(pt => pt.id === id);
    if (!p) return;

    if (role === "manual") {
        const input = target as HTMLInputElement;
        if (input.checked) {
            // enable manual: seed from auto
            const auto = currentAutoTangents();
            const t0 = auto[p.id] ?? { x: 0, y: 0 };
            p.tx = t0.x; p.ty = t0.y;
        } else {
            // disable: return to auto
            p.tx = undefined; p.ty = undefined;
        }
        redraw();
        return;
    }

    if (role === "clear") {
        p.tx = undefined; p.ty = undefined;
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



// ---------- GeoGebra export helpers ----------

type XY = { x: number; y: number };

/** Sample the current Hermite curve at N points per segment. */
function sampleCurvePoints(stepsPerSeg: number): XY[] {
    const sorted = points.slice().sort((a, b) => a.x - b.x);
    const auto = computeAutoTangents(sorted, 0);

    const out: XY[] = [];
    for (let i = 0; i + 1 < sorted.length; i++) {
        const p0 = sorted[i], p1 = sorted[i + 1];
        const m0 = p0.tx !== undefined && p0.ty !== undefined ? { x: p0.tx, y: p0.ty } : auto[p0.id] ?? { x: 0, y: 0 };
        const m1 = p1.tx !== undefined && p1.ty !== undefined ? { x: p1.tx, y: p1.ty } : auto[p1.id] ?? { x: 0, y: 0 };

        const m0c = clampHandleMagnitude({ x: p0.x, y: p0.y }, { x: p1.x, y: p1.y }, m0);
        const m1c = clampHandleMagnitude({ x: p0.x, y: p0.y }, { x: p1.x, y: p1.y }, m1);

        const seg = sampleHermiteSegment({ x: p0.x, y: p0.y }, { x: p1.x, y: p1.y }, m0c, m1c, stepsPerSeg);
        const startIdx = (i === 0) ? 0 : 1; // avoid duplicating the join point
        for (let k = startIdx; k < seg.length; k++) out.push({ x: seg[k].x, y: seg[k].y });
    }
    return out;
}

/** Format list literal: {(x1,y1),(x2,y2),...} with fixed decimals. */
function toGeogebraListLiteral(pts: XY[], decimals = 6): string {
    const fmt = (v: number) => Number.isFinite(v) ? v.toFixed(decimals) : "NaN";
    return "{ " + pts.map(p => `(${fmt(p.x)},${fmt(p.y)})`).join(", ") + " }";
}

/** Build Polyline command: list + polyline. */
function makeGeogebraPolyline(samplesPerSeg = 48): string {
    const pts = sampleCurvePoints(samplesPerSeg);
    const list = toGeogebraListLiteral(pts);
    return `Polyline(${list})`;
}

/** Build Spline command through clicked (sorted) points; optional order / weight. */
function makeGeogebraSpline(order: number | null = null, weight: "default" | "absx" = "default"): string {
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
function makeGeogebraParametric(): string {
    const sorted = points.slice().sort((a, b) => a.x - b.x);
    const auto = computeAutoTangents(sorted, 0);
    const nSeg = Math.max(0, sorted.length - 1);
    if (nSeg === 0) return "// Add at least two points";

    // Build cubic coefficients per segment: x(s)=ax s^3 + bx s^2 + cx s + dx, s in [0,1]
    type Coefs = { ax: number; bx: number; cx: number; dx: number };
    const coefsX: Coefs[] = [];
    const coefsY: Coefs[] = [];

    for (let i = 0; i < nSeg; i++) {
        const p0 = sorted[i], p1 = sorted[i + 1];
        const m0 = p0.tx !== undefined && p0.ty !== undefined ? { x: p0.tx, y: p0.ty } : auto[p0.id] ?? { x: 0, y: 0 };
        const m1 = p1.tx !== undefined && p1.ty !== undefined ? { x: p1.tx, y: p1.ty } : auto[p1.id] ?? { x: 0, y: 0 };

        const axX = 2*p0.x - 2*p1.x + m0.x + m1.x;
        const bxX = -3*p0.x + 3*p1.x - 2*m0.x - m1.x;
        const cxX = m0.x;
        const dxX = p0.x;

        const axY = 2*p0.y - 2*p1.y + m0.y + m1.y;
        const bxY = -3*p0.y + 3*p1.y - 2*m0.y - m1.y;
        const cxY = m0.y;
        const dxY = p0.y;

        coefsX.push({ ax: axX, bx: bxX, cx: cxX, dx: dxX });
        coefsY.push({ ax: axY, bx: bxY, cx: cxY, dx: dxY });
    }

    // Compose If(...) chains over t in [0,1]; local s = nSeg*t - i
    const D = 8; // decimals
    const fmt = (v: number) => Number.isFinite(v) ? v.toFixed(D) : "NaN";
    const pieceX: string[] = [];
    const pieceY: string[] = [];

    for (let i = 0; i < nSeg; i++) {
        const s = `( ${nSeg} * t - ${i} )`;
        const cond = i < nSeg - 1 ? `(t < ${(i+1)/nSeg})` : null;

        const c = coefsX[i];
        const exprX = `${fmt(c.ax)}*(${s})^3 + ${fmt(c.bx)}*(${s})^2 + ${fmt(c.cx)}*(${s}) + ${fmt(c.dx)}`;
        const d = coefsY[i];
        const exprY = `${fmt(d.ax)}*(${s})^3 + ${fmt(d.bx)}*(${s})^2 + ${fmt(d.cx)}*(${s}) + ${fmt(d.dx)}`;

        pieceX.push(cond ? `If${cond ? `(${cond}, ${exprX}, ` : ""}` : exprX);
        pieceY.push(cond ? `If${cond ? `(${cond}, ${exprY}, ` : ""}` : exprY);
    }

    // Close nested If(...) chains by appending final expressions and ')' brackets
    const closeIfs = (arr: string[]) => {
        let out = "";
        for (let i = 0; i < arr.length; i++) {
            if (i < arr.length - 1) out += arr[i]; else out += arr[i]; // last piece is the "else"
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
function makeCSV(samplesPerSeg = 48): string {
    const pts = sampleCurvePoints(samplesPerSeg);
    const lines = ["x,y", ...pts.map(p => `${p.x},${p.y}`)];
    return lines.join("\n");
}

/** Utils: copy to clipboard & download text file */
async function copyToClipboard(text: string) {
    try { await navigator.clipboard.writeText(text); } catch {}
}
function downloadTextFile(text: string, filename: string) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}

// ---------- Wire export panel ----------
const btnExportPolyline = document.getElementById("btnExportPolyline") as HTMLButtonElement;
const btnExportSpline   = document.getElementById("btnExportSpline") as HTMLButtonElement;
const btnExportParam    = document.getElementById("btnExportParam") as HTMLButtonElement;
const btnDownloadCSV    = document.getElementById("btnDownloadCSV") as HTMLButtonElement;
const samplesPerSegment = document.getElementById("samplesPerSegment") as HTMLInputElement;
const ggbOut            = document.getElementById("ggbOut") as HTMLTextAreaElement;

function currentSamples(): number {
    const n = parseInt(samplesPerSegment.value || "48", 10);
    return Number.isFinite(n) && n >= 2 ? n : 48;
}

btnExportPolyline.addEventListener("click", async () => {
    const script = makeGeogebraPolyline(currentSamples());
    ggbOut.value = script;
    await copyToClipboard(script);
});

btnExportSpline.addEventListener("click", async () => {
    // Default: cubic (order omitted) and GeoGebra’s default weight sqrt(x^2+y^2)
    const script = makeGeogebraSpline(null, "default");
    ggbOut.value = script;
    await copyToClipboard(script);
});

btnExportParam.addEventListener("click", async () => {
    const script = makeGeogebraParametric();
    ggbOut.value = script;
    await copyToClipboard(script);
});

btnDownloadCSV.addEventListener("click", () => {
    const csv = makeCSV(currentSamples());
    downloadTextFile(csv, "curve_points.csv");
});
