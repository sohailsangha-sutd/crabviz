function exportSVG() {
  const svg = document.querySelector("svg").cloneNode(true);

  svg.appendChild(document.getElementById("crabviz_style").cloneNode(true));
  svg.insertAdjacentHTML(
    "beforeend",
    "<style>:is(.cell, .edge) { pointer-events: none; }</style>"
  );

  acquireVsCodeApi().postMessage({
    command: 'saveSVG',
    svg: svg.outerHTML.replaceAll("&nbsp;", "&#160;")
  });
}

function exportCrabViz() {
  const svg = document.querySelector("svg");
  if (!svg) {
    console.error("No SVG found to export.");
    return;
  }

  const svgContent = svg.outerHTML.replaceAll("&nbsp;", "&#160;");
  acquireVsCodeApi().postMessage({
    command: 'saveSVG',
    svg: svgContent
  });
}

function saveJSON() {
  const svg = document.querySelector("svg");
  if (!svg) {
    console.error("No SVG found to export.");
    return;
  }

  const svgContent = svg.outerHTML.replaceAll("&nbsp;", "&#160;");
  acquireVsCodeApi().postMessage({
    command: 'saveJSON',
    svg: svgContent
  });
}

window.addEventListener('message', (e) => {
  const message = e.data;

  switch (message.command) {
    case 'exportSVG':
        exportSVG();
        break;
    case 'exportCrabViz':
        exportCrabViz();
        break;
    case 'saveJSON':
        saveJSON();
        break;
  }
});
