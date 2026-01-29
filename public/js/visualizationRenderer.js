// Visualization Renderer
// Handles rendering of HTML, SVG, charts, and markdown in the visualization area

class VisualizationRenderer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.currentChart = null;
  }

  // Main render method
  render(visualization) {
    if (!this.container) {
      console.error('Visualization container not found');
      return;
    }

    // Clear previous content
    this.clear();

    const { type, title, data, content } = visualization;

    // Create wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'visualization-content';

    // Add title
    const titleEl = document.createElement('h2');
    titleEl.className = 'visualization-title';
    titleEl.textContent = title;
    wrapper.appendChild(titleEl);

    // Create body
    const body = document.createElement('div');
    body.className = 'visualization-body';

    switch (type) {
      case 'html':
        this.renderHTML(body, content);
        break;
      case 'svg':
        this.renderSVG(body, content);
        break;
      case 'chart':
        this.renderChart(body, data);
        break;
      case 'markdown':
        this.renderMarkdown(body, content);
        break;
      default:
        body.innerHTML = `<p>Unknown visualization type: ${type}</p>`;
    }

    wrapper.appendChild(body);
    this.container.appendChild(wrapper);
  }

  // Clear the visualization container
  clear() {
    if (this.currentChart) {
      this.currentChart.destroy();
      this.currentChart = null;
    }
    this.container.innerHTML = '';
  }

  // Render HTML content in a sandboxed iframe
  renderHTML(container, content) {
    const iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-scripts';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.minHeight = '400px';

    container.appendChild(iframe);

    // Write content to iframe
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    iframeDoc.open();
    iframeDoc.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              background: #1a1a24;
              color: #e8e8ed;
              padding: 1rem;
              margin: 0;
            }
            table {
              border-collapse: collapse;
              width: 100%;
              margin: 1rem 0;
            }
            th, td {
              border: 1px solid #2a2a3a;
              padding: 0.5rem 1rem;
              text-align: left;
            }
            th {
              background: #12121a;
            }
            tr:nth-child(even) {
              background: rgba(255, 255, 255, 0.02);
            }
            a {
              color: #6366f1;
            }
          </style>
        </head>
        <body>${content}</body>
      </html>
    `);
    iframeDoc.close();
  }

  // Render SVG content directly
  renderSVG(container, content) {
    // Create a wrapper with appropriate sizing
    const svgWrapper = document.createElement('div');
    svgWrapper.style.width = '100%';
    svgWrapper.style.height = '100%';
    svgWrapper.style.display = 'flex';
    svgWrapper.style.alignItems = 'center';
    svgWrapper.style.justifyContent = 'center';

    // Sanitize and inject SVG
    // Basic sanitization - remove script tags
    const sanitized = content
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/on\w+="[^"]*"/gi, '');

    svgWrapper.innerHTML = sanitized;

    // Style the SVG
    const svg = svgWrapper.querySelector('svg');
    if (svg) {
      svg.style.maxWidth = '100%';
      svg.style.maxHeight = '100%';
      svg.style.height = 'auto';
    }

    container.appendChild(svgWrapper);
  }

  // Render Chart.js chart
  renderChart(container, data) {
    if (!data || !data.chartType) {
      container.innerHTML = '<p>Invalid chart data</p>';
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.style.maxWidth = '100%';
    canvas.style.maxHeight = '500px';
    container.appendChild(canvas);

    const ctx = canvas.getContext('2d');

    // Map chart type
    const chartTypes = {
      bar: 'bar',
      line: 'line',
      pie: 'pie',
      doughnut: 'doughnut',
      radar: 'radar',
      polarArea: 'polarArea'
    };

    const chartType = chartTypes[data.chartType] || 'bar';

    // Build chart config
    const config = {
      type: chartType,
      data: {
        labels: data.labels || [],
        datasets: (data.datasets || []).map((ds, i) => ({
          label: ds.label || `Dataset ${i + 1}`,
          data: ds.data || [],
          backgroundColor: ds.backgroundColor || this.getDefaultColors(data.labels?.length || ds.data?.length || 0),
          borderColor: ds.borderColor || (chartType === 'line' ? '#6366f1' : undefined),
          borderWidth: ds.borderWidth || (chartType === 'line' ? 2 : 1),
          fill: ds.fill !== undefined ? ds.fill : (chartType === 'line' ? false : undefined)
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: {
            labels: {
              color: '#e8e8ed'
            }
          }
        },
        scales: chartType === 'pie' || chartType === 'doughnut' ? {} : {
          x: {
            ticks: { color: '#8888a0' },
            grid: { color: '#2a2a3a' }
          },
          y: {
            ticks: { color: '#8888a0' },
            grid: { color: '#2a2a3a' }
          }
        }
      }
    };

    // Create chart
    if (typeof Chart !== 'undefined') {
      this.currentChart = new Chart(ctx, config);
    } else {
      container.innerHTML = '<p>Chart.js not loaded</p>';
    }
  }

  // Render markdown content
  renderMarkdown(container, content) {
    const markdownDiv = document.createElement('div');
    markdownDiv.className = 'markdown-content';

    if (typeof marked !== 'undefined') {
      markdownDiv.innerHTML = marked.parse(content || '');
    } else {
      // Basic fallback rendering
      markdownDiv.innerHTML = content
        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
        .replace(/^# (.*$)/gim, '<h1>$1</h1>')
        .replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>')
        .replace(/\*(.*)\*/gim, '<em>$1</em>')
        .replace(/\n/gim, '<br>');
    }

    container.appendChild(markdownDiv);
  }

  // Get default colors for charts
  getDefaultColors(count) {
    const palette = [
      '#6366f1', // indigo
      '#22c55e', // green
      '#f59e0b', // amber
      '#ef4444', // red
      '#8b5cf6', // violet
      '#06b6d4', // cyan
      '#ec4899', // pink
      '#f97316', // orange
    ];

    const colors = [];
    for (let i = 0; i < count; i++) {
      colors.push(palette[i % palette.length]);
    }
    return colors;
  }

  // Show placeholder
  showPlaceholder() {
    this.clear();
    this.container.innerHTML = `
      <div class="visualization-placeholder">
        <p>Visualizations will appear here</p>
        <p class="hint">Ask the agent to create charts, diagrams, or tables</p>
      </div>
    `;
  }
}

// Export for use in space.js
window.VisualizationRenderer = VisualizationRenderer;
