
// Minimal typing for global Plotly from CDN
declare const Plotly: any;

type Point = { x: number; y: number };

const plotDiv = document.getElementById("plot") as HTMLDivElement;
const resetBtn = document.getElementById("resetBtn") as HTMLButtonElement;
const splineToggle = document.getElementById("splineToggle") as HTMLInputElement;

// In-memory list of points
let points: Point[] = [];

// Initial Plotly layout & data
const layout: any = {
    margin: { l: 50, r: 20, t: 30, b: 50 },
    hovermode: false,
    xaxis: { range: [0, 10], zeroline: false, gridcolor: "#eee" },
    yaxis: { range: [0, 10], zeroline: false, gridcolor: "#eee" },
};

const traceMarkers: any = {
    x: [],
    y: [],
    mode: "markers",
    name: "Points",
    marker: { color: "#1f77b4", size: 8 },
};

const traceCurve: any = {
    x: [],
    y: [],
    mode: "lines",
    name: "Curve",
    line: { color: "#ff7f0e", width: 3, shape: "spline" }, // toggled later
};

Plotly.newPlot(plotDiv, [traceCurve, traceMarkers], layout, { displayModeBar: true });

// Re-render plot from `points`
function redraw() {
    // Sort points by x to make a well-defined path
    const sorted = points.slice().sort((a, b) => a.x - b.x);

    const xs = sorted.map((p) => p.x);
    const ys = sorted.map((p) => p.y);

    // Update markers
    Plotly.react(plotDiv, [
        {
            ...traceCurve,
            x: xs,
            y: ys,
            line: {
                ...traceCurve.line,
                shape: splineToggle.checked ? "spline" : "linear",
            },
        },
        {
            ...traceMarkers,
            x: xs,
            y: ys,
        },
    ], layout);
}

// Convert a click in the plot DIV to data coordinates
function eventToDataCoords(ev: MouseEvent): Point | null {
    // Plotly injects internal layout with converters:
    //  - xaxis.p2c(pixel) converts pixel => data coord
    //  - yaxis.p2c(pixel) converts pixel => data coord
    const full = (plotDiv as any)._fullLayout;
    if (!full || !full.xaxis || !full.yaxis) return null;

    const rect = plotDiv.getBoundingClientRect();

    // Pixel position relative to the entire plot DIV
    const xPixel = ev.clientX - rect.left;
    const yPixel = ev.clientY - rect.top;

    // Plot area offsets in pixels
    const plotArea = full._plots?.xy?.plot || full.plot; // compatibility across Plotly versions
    if (!plotArea) return null;

    const { l: leftPad, t: topPad } = full;
    const innerX = xPixel - leftPad;
    const innerY = yPixel - topPad;

    // Bounds check: only accept clicks inside the plot area
    const w = full._size?.w ?? plotArea.width;
    const h = full._size?.h ?? plotArea.height;

    if (innerX < 0 || innerY < 0 || innerX > w || innerY > h) {
        return null; // clicked outside the plotting rectangle
    }

    // Convert pixels to data using axis converters
    const x = full.xaxis.p2c(innerX);
    const y = full.yaxis.p2c(innerY);

    if (typeof x !== "number" || typeof y !== "number") return null;
    return { x, y };
}

// Click handler to add a point
function onPlotClick(ev: MouseEvent) {
    const p = eventToDataCoords(ev);
    if (!p) return;

    points.push(p);
    redraw();
}

// Reset button
resetBtn.addEventListener("click", () => {
    points = [];
    redraw();
});

// Toggle spline vs linear
splineToggle.addEventListener("change", () => {
    redraw();
});

// Attach click listener on the Plotly graph area
plotDiv.addEventListener("click", onPlotClick);

// Optional: make axes auto-expand to include new points
function autoExpandAxesToPoints() {
    if (points.length === 0) return;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);

    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);

    const padX = (maxX - minX || 1) * 0.1;
    const padY = (maxY - minY || 1) * 0.1;

    Plotly.relayout(plotDiv, {
        "xaxis.range": [minX - padX, maxX + padX],
        "yaxis.range": [minY - padY, maxY + padY],
    });
}

// If you want auto-expand, call autoExpandAxesToPoints() inside redraw()
// (Commented by default to keep ranges stable.)
// function redraw() {
//   const sorted = points.slice().sort((a, b) => a.x - b.x);
//   const xs = sorted.map((p) => p.x);
//   const ys = sorted.map((p) => p.y);
//   Plotly.react(plotDiv, [
//     { ...traceCurve, x: xs, y: ys, line: { ...traceCurve.line, shape: splineToggle.checked ? "spline" : "linear" } },
//     { ...traceMarkers, x: xs, y: ys },
//   ], layout);
//   autoExpandAxesToPoints();
// }
