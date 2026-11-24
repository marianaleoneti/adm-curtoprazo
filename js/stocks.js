const SYMBOLS = ["POMO3", "POMO4"];
const AUTO_REFRESH_MS = 15 * 60 * 1000;
const SVG_NS = "http://www.w3.org/2000/svg";
const MARKET_API_BASE_URL =
  document.querySelector('meta[name="market-api-base-url"]')?.content.trim().replace(/\/+$/, "") || "";

const currencyFormat = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL"
});
const compactCurrencyFormat = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  notation: "compact",
  maximumFractionDigits: 2
});
const chartCurrencyFormat = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 2
});
const numberFormat = new Intl.NumberFormat("pt-BR");
const compactNumberFormat = new Intl.NumberFormat("pt-BR", {
  notation: "compact",
  maximumFractionDigits: 1
});
const percentFormat = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const marketTimeFormat = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo"
});
const chartDateFormat = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "short",
  timeZone: "America/Sao_Paulo"
});

function getElement(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Elemento obrigatório não encontrado: #${id}`);
  return element;
}

function getApiError(status) {
  const messages = {
    401: "Não foi possível acessar as cotações no momento.",
    403: "As cotações estão temporariamente indisponíveis.",
    404: "Não encontramos cotações para os ativos selecionados.",
    429: "Muitas consultas em sequência. Aguarde um pouco antes de tentar novamente."
  };
  return messages[status] || "Não foi possível carregar as cotações no momento.";
}

function getApiSetupError() {
  if (window.location.protocol === "file:") {
    return "Não foi possível carregar as cotações. Abra a aplicação pelo endereço do site e tente novamente.";
  }
  if (!MARKET_API_BASE_URL) {
    return "Não foi possível carregar as cotações no momento. Tente novamente mais tarde.";
  }
  return "";
}

async function requestBrapi(path) {
  let response;
  try {
    response = await fetch(`${MARKET_API_BASE_URL}${path}`, {
      cache: "no-store"
    });
  } catch (error) {
    console.error("Erro de rede ao consultar a API de mercado:", error);
    throw new Error("Não foi possível conectar às cotações. Verifique sua conexão e tente novamente.");
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    console.error("Resposta JSON inválida recebida do servidor de mercado:", error);
    throw new Error("Não foi possível ler as cotações no momento.");
  }

  if (!response.ok) {
    const apiError = new Error(getApiError(response.status));
    apiError.status = response.status;
    apiError.code = payload && typeof payload.code === "string" ? payload.code : "";
    apiError.retryAfter = response.headers.get("Retry-After");
    throw apiError;
  }

  if (!payload || !Array.isArray(payload.results)) {
    throw new Error("Não foi possível carregar as cotações no momento.");
  }
  return payload.results;
}

async function requestBrapiForSymbols(path, parameters = {}) {
  const results = [];
  for (const symbol of SYMBOLS) {
    const query = new URLSearchParams({ ...parameters, symbols: symbol });
    results.push(...await requestBrapi(`${path}?${query}`));
  }
  return results;
}

function findSymbolResult(results, symbol) {
  return results.find(result => result.symbol === symbol || result.requestedSymbol === symbol);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatOptionalCurrency(value) {
  return isFiniteNumber(value) ? currencyFormat.format(value) : "—";
}

function render52WeekRange(suffix, data) {
  const low = data.fiftyTwoWeekLow;
  const high = data.fiftyTwoWeekHigh;
  const price = data.regularMarketPrice;
  const lowElement = getElement(`market52wLow${suffix}`);
  const highElement = getElement(`market52wHigh${suffix}`);
  const currentPriceElement = getElement(`market52wCurrent${suffix}`);
  const positionElement = getElement(`market52wPosition${suffix}`);

  lowElement.textContent = formatOptionalCurrency(low);
  highElement.textContent = formatOptionalCurrency(high);
  currentPriceElement.textContent = formatOptionalCurrency(price);
  if (!isFiniteNumber(price) || !isFiniteNumber(low) || !isFiniteNumber(high) || high <= low) {
    positionElement.textContent = "—";
    return;
  }

  const position = Math.min(100, Math.max(0, (price - low) / (high - low) * 100));
  positionElement.textContent = `${percentFormat.format(position)}% da faixa`;
}

function formatMarketTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Horário do pregão indisponível" : marketTimeFormat.format(date);
}

function formatSigned(value, formatter) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatter.format(value)}`;
}

function svgElement(name, attributes = {}, text = "") {
  const element = document.createElementNS(SVG_NS, name);
  for (const [attribute, value] of Object.entries(attributes)) {
    element.setAttribute(attribute, value);
  }
  if (text) element.textContent = text;
  return element;
}

export function initializeStocksTab() {
  const refreshButton = getElement("marketRefreshButton");
  const statusElement = getElement("marketStatus");
  const marketSection = getElement("acoes");
  const marketTabButton = document.querySelector('.tab-btn[data-tab="acoes"]');
  if (!marketTabButton) throw new Error("Botão obrigatório da aba Ações não encontrado.");
  const chartSymbolSelect = getElement("marketChartSymbol");
  const chartRangeSelect = getElement("marketChartRange");
  const chartContainer = getElement("marketChart");
  const chartDescription = getElement("marketChartDescription");
  const comparisonChart = getElement("marketComparisonChart");
  const performanceSummary = getElement("marketPerformanceSummary");

  let busy = false;
  let hasQuoteData = false;
  let retryUntil = 0;
  let retryTimer = null;
  let refreshTimer = null;
  let historyBySymbol = {};
  let lastQuoteUpdate = null;

  function setStatus(message, state = "") {
    statusElement.textContent = message;
    statusElement.classList.toggle("is-error", state === "error");
    statusElement.classList.toggle("is-warning", state === "warning");
  }

  function setBusy(isBusy) {
    busy = isBusy;
    refreshButton.disabled = isBusy || Date.now() < retryUntil;
    chartSymbolSelect.disabled = isBusy || !hasQuoteData;
    chartRangeSelect.disabled = isBusy || !hasQuoteData;
  }

  function applyRetryAfter(value) {
    if (!value) return;
    const seconds = Number(value);
    const retryDelay = Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : Date.parse(value) - Date.now();
    if (!Number.isFinite(retryDelay) || retryDelay < 0) return;

    retryUntil = Date.now() + retryDelay;
    if (retryTimer) window.clearInterval(retryTimer);
    const updateCountdown = () => {
      const remaining = Math.ceil((retryUntil - Date.now()) / 1000);
      if (remaining <= 0) {
        window.clearInterval(retryTimer);
        retryTimer = null;
        setBusy(false);
        return;
      }
      refreshButton.disabled = true;
      setStatus(`Aguarde ${remaining} s antes de tentar novamente.`, "warning");
    };
    updateCountdown();
    retryTimer = window.setInterval(updateCountdown, 1000);
  }

  function renderQuotes(results) {
    const missingSymbols = [];
    const companyResult = results.find(result => result && result.data && isFiniteNumber(result.data.marketCap));
    getElement("marketCompanyMarketCap").textContent = companyResult
      ? compactCurrencyFormat.format(companyResult.data.marketCap)
      : "—";

    for (const symbol of SYMBOLS) {
      const suffix = symbol === "POMO3" ? "Pomo3" : "Pomo4";
      const result = findSymbolResult(results, symbol);
      const priceElement = getElement(`marketPrice${suffix}`);
      const changeElement = getElement(`marketChange${suffix}`);
      if (!result || !result.data) {
        priceElement.textContent = "Sem cotação";
        changeElement.textContent = "A brapi não retornou este ativo.";
        render52WeekRange(suffix, {});
        missingSymbols.push(symbol);
        continue;
      }

      const data = result.data;
      render52WeekRange(suffix, data);
      const nameElement = getElement(`marketName${suffix}`);
      nameElement.textContent = data.shortName || data.longName || (symbol === "POMO3" ? "Marcopolo ON" : "Marcopolo PN");
      if (!isFiniteNumber(data.regularMarketPrice)) {
        priceElement.textContent = "—";
        changeElement.textContent = "Preço indisponível";
        changeElement.classList.remove("is-positive", "is-negative");
        missingSymbols.push(symbol);
        continue;
      }

      priceElement.textContent = currencyFormat.format(data.regularMarketPrice);
      getElement(`marketTime${suffix}`).textContent = data.regularMarketTime
        ? `Pregão: ${formatMarketTime(data.regularMarketTime)}`
        : "Horário do pregão indisponível";
      getElement(`marketOpen${suffix}`).textContent = formatOptionalCurrency(data.regularMarketOpen);
      getElement(`marketHigh${suffix}`).textContent = formatOptionalCurrency(data.regularMarketDayHigh);
      getElement(`marketLow${suffix}`).textContent = formatOptionalCurrency(data.regularMarketDayLow);
      getElement(`marketPrevious${suffix}`).textContent = formatOptionalCurrency(data.regularMarketPreviousClose);
      getElement(`marketVolume${suffix}`).textContent = isFiniteNumber(data.regularMarketVolume)
        ? numberFormat.format(data.regularMarketVolume)
        : "—";

      if (isFiniteNumber(data.regularMarketChange) && isFiniteNumber(data.regularMarketChangePercent)) {
        const changeText = formatSigned(data.regularMarketChange, currencyFormat);
        const percentText = formatSigned(data.regularMarketChangePercent, percentFormat);
        changeElement.textContent = `${changeText} (${percentText}%)`;
        changeElement.classList.toggle("is-positive", data.regularMarketChange > 0);
        changeElement.classList.toggle("is-negative", data.regularMarketChange < 0);
      } else {
        changeElement.textContent = "Variação indisponível";
        changeElement.classList.remove("is-positive", "is-negative");
      }
    }
    return missingSymbols;
  }

  function showEmptyChart(message, container = chartContainer) {
    const paragraph = document.createElement("p");
    paragraph.className = "market-chart-empty";
    paragraph.textContent = message;
    container.replaceChildren(paragraph);
  }

  function renderHistoryChart() {
    const symbol = chartSymbolSelect.value;
    const rows = historyBySymbol[symbol] || [];
    if (!rows.length) {
      showEmptyChart(`Não há histórico disponível para ${symbol} neste período.`);
      chartDescription.textContent = "O histórico diário será exibido após uma consulta bem-sucedida.";
      return;
    }

    const priceValues = rows.flatMap(row =>
      [row.low, row.high, row.open, row.close].filter(isFiniteNumber)
    );
    const dataMinimum = Math.min(...priceValues);
    const dataMaximum = Math.max(...priceValues);
    const paddingValue = (dataMaximum - dataMinimum) || Math.max(dataMaximum * 0.02, 0.01);
    const minimum = dataMinimum - paddingValue * 0.12;
    const maximum = dataMaximum + paddingValue * 0.12;
    const width = 760;
    const height = 356;
    const margins = { top: 24, right: 24, bottom: 24, left: 86 };
    const priceTop = margins.top;
    const priceBottom = 218;
    const volumeTop = 250;
    const volumeBottom = 320;
    const plotWidth = width - margins.left - margins.right;
    const priceHeight = priceBottom - priceTop;
    const volumeHeight = volumeBottom - volumeTop;
    const volumeMaximum = Math.max(0, ...rows.map(row =>
      isFiniteNumber(row.volume) ? row.volume : 0
    ));
    const xForIndex = index => margins.left
      + index / Math.max(rows.length - 1, 1) * plotWidth;
    const yForPrice = value => priceTop + (maximum - value) / (maximum - minimum) * priceHeight;
    const candleWidth = Math.max(3, Math.min(12, plotWidth / rows.length * 0.56));

    const svg = svgElement("svg", {
      class: "market-chart-svg",
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": `Candles de preço e volume diário de ${symbol}`
    });
    svg.appendChild(svgElement("title", {}, `Candles e volume de ${symbol}`));

    for (let index = 0; index <= 4; index += 1) {
      const fraction = index / 4;
      const y = priceTop + fraction * priceHeight;
      const value = maximum - fraction * (maximum - minimum);
      svg.appendChild(svgElement("line", {
        class: "market-chart-grid",
        x1: margins.left,
        x2: width - margins.right,
        y1: y,
        y2: y
      }));
      svg.appendChild(svgElement("text", {
        class: "market-chart-axis",
        x: margins.left - 10,
        y: y + 4,
        "text-anchor": "end"
      }, chartCurrencyFormat.format(value)));
    }

    svg.appendChild(svgElement("text", {
      class: "market-chart-axis",
      x: margins.left,
      y: volumeTop - 8
    }, "Volume (ações)"));

    for (let index = 0; index <= 2; index += 1) {
      const fraction = index / 2;
      const y = volumeBottom - fraction * volumeHeight;
      const value = volumeMaximum * fraction;
      svg.appendChild(svgElement("line", {
        class: "market-chart-grid",
        x1: margins.left,
        x2: width - margins.right,
        y1: y,
        y2: y
      }));
      svg.appendChild(svgElement("text", {
        class: "market-chart-axis",
        x: margins.left - 10,
        y: y + 4,
        "text-anchor": "end"
      }, compactNumberFormat.format(value)));
    }

    rows.forEach((row, index) => {
      const x = xForIndex(index);
      const date = chartDateFormat.format(new Date(row.date * 1000));
      const hasOhlc = [row.open, row.high, row.low, row.close].every(isFiniteNumber);
      const direction = hasOhlc
        ? row.close > row.open ? "up" : row.close < row.open ? "down" : "flat"
        : "flat";

      if (hasOhlc) {
        const group = svgElement("g", { class: `market-candle market-candle-${direction}` });
        group.appendChild(svgElement("title", {}, `${date} · Abertura ${currencyFormat.format(row.open)} · Máxima ${currencyFormat.format(row.high)} · Mínima ${currencyFormat.format(row.low)} · Fechamento ${currencyFormat.format(row.close)}`));
        group.appendChild(svgElement("line", {
          class: `market-candle-wick market-candle-${direction}`,
          x1: x,
          x2: x,
          y1: yForPrice(row.high),
          y2: yForPrice(row.low)
        }));
        const bodyTop = Math.min(yForPrice(row.open), yForPrice(row.close));
        const bodyHeight = Math.max(1.5, Math.abs(yForPrice(row.open) - yForPrice(row.close)));
        group.appendChild(svgElement("rect", {
          class: `market-candle-body market-candle-${direction}`,
          x: x - candleWidth / 2,
          y: bodyTop,
          width: candleWidth,
          height: bodyHeight,
          rx: 1
        }));
        svg.appendChild(group);
      } else {
        const closePoint = svgElement("circle", {
          class: "market-chart-point",
          cx: x,
          cy: yForPrice(row.close),
          r: 3
        });
        closePoint.appendChild(svgElement("title", {}, `${date} · Fechamento ${currencyFormat.format(row.close)} · Dados OHLC indisponíveis`));
        svg.appendChild(closePoint);
      }

      if (isFiniteNumber(row.volume) && row.volume > 0 && volumeMaximum > 0) {
        const barHeight = row.volume / volumeMaximum * volumeHeight;
        const volumeBar = svgElement("rect", {
          class: `market-volume-bar market-candle-${direction}`,
          x: x - candleWidth / 2,
          y: volumeBottom - barHeight,
          width: candleWidth,
          height: barHeight,
          rx: 1
        });
        volumeBar.appendChild(svgElement("title", {}, `${date} · Volume ${numberFormat.format(row.volume)}`));
        svg.appendChild(volumeBar);
      }
    });

    const labelIndices = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
    for (const index of labelIndices) {
      const x = xForIndex(index);
      svg.appendChild(svgElement("text", {
        class: "market-chart-axis",
        x,
        y: height - 8,
        "text-anchor": index === 0 ? "start" : index === rows.length - 1 ? "end" : "middle"
      }, chartDateFormat.format(new Date(rows[index].date * 1000))));
    }

    chartContainer.replaceChildren(svg);
    chartDescription.textContent =
      `${symbol} · ${rows.length} pregões · Preços em reais; volume em ações negociadas.`;
  }

  function renderPerformanceComparison() {
    performanceSummary.replaceChildren();
    const seriesBySymbol = {};
    for (const symbol of SYMBOLS) {
      seriesBySymbol[symbol] = new Map(
        (historyBySymbol[symbol] || [])
          .map(row => {
            const value = isFiniteNumber(row.adjustedClose) && row.adjustedClose > 0
              ? row.adjustedClose
              : row.close;
            return [row.date, value];
          })
          .filter(([, value]) => isFiniteNumber(value) && value > 0)
      );
    }

    const commonDates = [...seriesBySymbol[SYMBOLS[0]].keys()]
      .filter(date => seriesBySymbol[SYMBOLS[1]].has(date))
      .sort((left, right) => left - right);
    if (commonDates.length < 2) {
      const message = "Não há datas comuns suficientes para comparar o desempenho dos ativos.";
      showEmptyChart(message, performanceSummary);
      showEmptyChart(message, comparisonChart);
      return;
    }

    const performanceBySymbol = {};
    for (const symbol of SYMBOLS) {
      const series = seriesBySymbol[symbol];
      const base = series.get(commonDates[0]);
      performanceBySymbol[symbol] = commonDates.map(date => ({
        date,
        value: (series.get(date) / base - 1) * 100
      }));

      const periodReturn = performanceBySymbol[symbol][commonDates.length - 1].value;
      const item = document.createElement("div");
      item.className = "market-performance-item";
      const label = document.createElement("span");
      label.className = "market-performance-symbol";
      label.textContent = symbol;
      const value = document.createElement("strong");
      value.className = "market-performance-value";
      value.textContent = `${formatSigned(periodReturn, percentFormat)}%`;
      value.classList.toggle("is-positive", periodReturn > 0);
      value.classList.toggle("is-negative", periodReturn < 0);
      item.append(label, value);
      performanceSummary.appendChild(item);
    }

    const allValues = SYMBOLS.flatMap(symbol =>
      performanceBySymbol[symbol].map(point => point.value)
    );
    const dataMinimum = Math.min(0, ...allValues);
    const dataMaximum = Math.max(0, ...allValues);
    const paddingValue = (dataMaximum - dataMinimum) || 1;
    const minimum = dataMinimum - paddingValue * 0.12;
    const maximum = dataMaximum + paddingValue * 0.12;
    const width = 760;
    const height = 280;
    const margins = { top: 22, right: 24, bottom: 34, left: 82 };
    const plotWidth = width - margins.left - margins.right;
    const plotHeight = height - margins.top - margins.bottom;
    const xForIndex = index => margins.left
      + index / Math.max(commonDates.length - 1, 1) * plotWidth;
    const yForValue = value => margins.top
      + (maximum - value) / (maximum - minimum) * plotHeight;
    const svg = svgElement("svg", {
      class: "market-chart-svg",
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": "Comparativo de retorno acumulado de POMO3 e POMO4"
    });
    svg.appendChild(svgElement("title", {}, "Retorno acumulado de POMO3 e POMO4"));

    for (let index = 0; index <= 4; index += 1) {
      const fraction = index / 4;
      const y = margins.top + fraction * plotHeight;
      const value = maximum - fraction * (maximum - minimum);
      svg.appendChild(svgElement("line", {
        class: "market-chart-grid",
        x1: margins.left,
        x2: width - margins.right,
        y1: y,
        y2: y
      }));
      svg.appendChild(svgElement("text", {
        class: "market-chart-axis",
        x: margins.left - 10,
        y: y + 4,
        "text-anchor": "end"
      }, `${formatSigned(value, percentFormat)}%`));
    }

    for (const symbol of SYMBOLS) {
      const points = performanceBySymbol[symbol].map((point, index) => ({
        ...point,
        x: xForIndex(index),
        y: yForValue(point.value)
      }));
      const seriesClass = symbol.toLowerCase();
      const path = points.map((point, index) =>
        `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
      ).join(" ");
      svg.appendChild(svgElement("path", {
        class: `market-comparison-line market-comparison-line-${seriesClass}`,
        d: path
      }));

      for (const point of points) {
        const circle = svgElement("circle", {
          class: `market-comparison-point-${seriesClass}`,
          cx: point.x,
          cy: point.y,
          r: 2.5
        });
        circle.appendChild(svgElement("title", {}, `${symbol} · ${chartDateFormat.format(new Date(point.date * 1000))}: ${formatSigned(point.value, percentFormat)}%`));
        svg.appendChild(circle);
      }
    }

    const labelIndices = [...new Set([0, Math.floor((commonDates.length - 1) / 2), commonDates.length - 1])];
    for (const index of labelIndices) {
      svg.appendChild(svgElement("text", {
        class: "market-chart-axis",
        x: xForIndex(index),
        y: height - 8,
        "text-anchor": index === 0 ? "start" : index === commonDates.length - 1 ? "end" : "middle"
      }, chartDateFormat.format(new Date(commonDates[index] * 1000))));
    }

    comparisonChart.replaceChildren(svg);
  }

  function renderHistory(results) {
    const missingSymbols = [];
    historyBySymbol = {};
    for (const symbol of SYMBOLS) {
      const result = findSymbolResult(results, symbol);
      const historicalRows = result && result.data && result.data.historicalDataPrice;
      if (!Array.isArray(historicalRows)) {
        historyBySymbol[symbol] = [];
        missingSymbols.push(symbol);
        continue;
      }

      historyBySymbol[symbol] = historicalRows
        .filter(row => row && typeof row === "object")
        .map(row => ({
          date: isFiniteNumber(row.date) ? row.date : null,
          open: isFiniteNumber(row.open) ? row.open : null,
          high: isFiniteNumber(row.high) ? row.high : null,
          low: isFiniteNumber(row.low) ? row.low : null,
          close: isFiniteNumber(row.close) ? row.close : null,
          adjustedClose: isFiniteNumber(row.adjustedClose) ? row.adjustedClose : null,
          volume: isFiniteNumber(row.volume) ? row.volume : null
        }))
        .filter(row => row.date !== null && row.close !== null)
        .sort((left, right) => left.date - right.date);
      if (!historyBySymbol[symbol].length) missingSymbols.push(symbol);
    }
    renderHistoryChart();
    renderPerformanceComparison();
    return missingSymbols;
  }

  function renderStatus(quoteMissing, historyMissing = [], historyError = "") {
    const updatedAt = lastQuoteUpdate ? marketTimeFormat.format(lastQuoteUpdate) : "—";
    const messages = [`Cotações atualizadas às ${updatedAt}.`];
    if (quoteMissing.length) messages.push(`Cotação indisponível para ${quoteMissing.join(", ")}.`);
    if (historyMissing.length) messages.push(`Histórico indisponível para ${historyMissing.join(", ")}.`);
    if (historyError) messages.push("Não foi possível atualizar o histórico agora.");
    setStatus(messages.join(" "), quoteMissing.length || historyMissing.length || historyError ? "warning" : "");
  }

  async function loadMarketData(includeHistory) {
    const setupError = getApiSetupError();
    if (setupError) {
      setStatus(setupError, "error");
      return false;
    }
    if (busy || Date.now() < retryUntil) return false;
    setBusy(true);
    let quoteMissing;
    try {
      const quoteResults = await requestBrapiForSymbols("/api/market/quote");
      quoteMissing = renderQuotes(quoteResults);
      lastQuoteUpdate = new Date();
      hasQuoteData = true;
    } catch (error) {
      console.error("Falha ao carregar cotações de mercado:", error);
      if (error.status === 429) applyRetryAfter(error.retryAfter);
      setStatus(error.message, "error");
      setBusy(false);
      return false;
    }

    let historyMissing = [];
    let historyError = "";
    if (includeHistory) {
      const range = chartRangeSelect.value;
      try {
        const historyResults = await requestBrapiForSymbols("/api/market/historical", { range });
        historyMissing = renderHistory(historyResults);
      } catch (error) {
        console.error("Falha ao carregar histórico de mercado:", error);
        if (error.status === 429) applyRetryAfter(error.retryAfter);
        historyError = error.message;
      }
    }

    renderStatus(quoteMissing, historyMissing, historyError);
    setBusy(false);
    return true;
  }

  async function loadHistoryOnly() {
    const setupError = getApiSetupError();
    if (setupError) {
      setStatus(setupError, "error");
      return;
    }
    if (busy || !hasQuoteData || Date.now() < retryUntil) return;
    setBusy(true);
    try {
      const historyResults = await requestBrapiForSymbols("/api/market/historical", {
        range: chartRangeSelect.value
      });
      const missingSymbols = renderHistory(historyResults);
      renderStatus([], missingSymbols);
    } catch (error) {
      console.error("Falha ao carregar histórico de mercado:", error);
      if (error.status === 429) applyRetryAfter(error.retryAfter);
      setStatus("Não foi possível atualizar o histórico agora. Tente novamente.", "error");
    } finally {
      setBusy(false);
    }
  }

  marketTabButton.addEventListener("click", async () => {
    if (hasQuoteData || busy) return;
    const loaded = await loadMarketData(true);
    if (loaded && !refreshTimer) {
      refreshTimer = window.setInterval(() => {
        if (document.visibilityState === "visible" && marketSection.classList.contains("active")) {
          void loadMarketData(false);
        }
      }, AUTO_REFRESH_MS);
    }
  });

  refreshButton.addEventListener("click", () => void loadMarketData(true));
  chartRangeSelect.addEventListener("change", () => void loadHistoryOnly());
  chartSymbolSelect.addEventListener("change", renderHistoryChart);
}
