/*
 * main.js — browser-based HTTP round-trip latency tester.
 *
 * Measures the time for a browser to fetch a remote image (typically a
 * favicon) using Image() + a cache-buster query string. Reports rolling
 * statistics (last, min, max, average, percentiles, jitter) and plots
 * the samples in a Google Material Line chart.
 *
 * This is NOT an ICMP ping. It includes DNS, TCP, TLS, HTTP, and browser
 * image-decoding overhead. For network-layer ping, use your OS tool.
 *
 * Depends on:
 *   - https://www.gstatic.com/charts/loader.js  (loaded in index.html)
 *   - DOM elements matching the ids in index.html
 */
(function () {
    'use strict';

    /* ============================================================
     * Configuration
     * ============================================================ */
    var CONFIG = {
        MIN_INTERVAL_MS: 1000,
        MAX_INTERVAL_MS: 60 * 60 * 1000,   // 1 hour
        MAX_SAMPLES: 200,                   // rolling window for stats + chart
        PING_TIMEOUT_MS: 5000,
        STORAGE_KEY: 'pingTester.settings.v1'
    };

    /* ============================================================
     * Application state
     * ============================================================ */
    var state = {
        running: false,
        intervalId: null,
        inFlight: false,
        samples: [],          // { i:number, t:msEpoch, ms:number, ok:boolean }
        nextIndex: 1,
        chart: null,          // google.charts.Line instance (null until ready)
        dataTable: null       // google.visualization.DataTable (null until ready)
    };

    /* ============================================================
     * DOM lookups
     * ============================================================ */
    function $(id) { return document.getElementById(id); }
    var els = {
        status: $('status'),
        ping: $('ping_num'),
        last: $('last_num'),
        high: $('high_num'),
        low: $('low_num'),
        avg: $('avg_num'),
        p50: $('p50_num'),
        p95: $('p95_num'),
        p99: $('p99_num'),
        jitter: $('jitter_num'),
        count: $('count_num'),
        chart: $('linechart_material'),
        address: $('address'),
        time: $('time'),
        test: $('test'),
        start: $('start'),
        stop: $('stop'),
        reset: $('reset'),
        exportBtn: $('export')
    };

    /* ============================================================
     * Utilities
     * ============================================================ */
    function clamp(value, lo, hi) {
        return Math.min(hi, Math.max(lo, value));
    }

    function fmtMs(value) {
        return Number.isFinite(value) ? value.toFixed(1) : '—';
    }

    function setStatus(text, variant) {
        els.status.textContent = text;
        els.status.className = 'badge bg-' + (variant || 'secondary');
    }

    function updateButtonStates() {
        var chartReady = !!state.chart;
        els.test.disabled      = !chartReady || state.inFlight;
        els.start.disabled     = !chartReady || state.running || state.inFlight;
        els.stop.disabled      = !chartReady || !state.running;
        els.reset.disabled     = !chartReady || state.running;
        els.exportBtn.disabled = state.samples.length === 0;
    }

    /* ============================================================
     * Settings persistence
     * ============================================================ */
    function loadSettings() {
        try {
            var raw = localStorage.getItem(CONFIG.STORAGE_KEY);
            if (!raw) { return; }
            var parsed = JSON.parse(raw);
            if (typeof parsed.address === 'string' && parsed.address) {
                els.address.value = parsed.address;
            }
            if (typeof parsed.time === 'number' && parsed.time > 0) {
                els.time.value = clamp(parsed.time, CONFIG.MIN_INTERVAL_MS, CONFIG.MAX_INTERVAL_MS);
            }
        } catch (_e) { /* corrupt storage — ignore */ }
    }

    function saveSettings() {
        try {
            localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({
                address: els.address.value,
                time: parseInt(els.time.value, 10) || 5000
            }));
        } catch (_e) { /* quota exceeded — ignore */ }
    }

    /* ============================================================
     * Ping
     * ============================================================ */
    /*
     * Fetch a URL via Image() and resolve with { ok, ms }.
     * - ok=true  → image loaded
     * - ok=false → network error, HTTP error, or timeout
     *
     * In all cases, ms is a real round-trip measurement. The distinction
     * matters for interpretation but not for latency statistics.
     */
    function pingOnce(url) {
        return new Promise(function (resolve) {
            var started = performance.now();
            var settled = false;
            var timerId;

            function finish(ok) {
                if (settled) { return; }
                settled = true;
                clearTimeout(timerId);
                resolve({ ok: ok, ms: performance.now() - started });
            }

            timerId = setTimeout(function () { finish(false); }, CONFIG.PING_TIMEOUT_MS);

            var img = new Image();
            img.onload  = function () { finish(true);  };
            img.onerror = function () { finish(false); };

            /* Cache-buster: each probe must be a fresh request. */
            var sep = url.indexOf('?') === -1 ? '?' : '&';
            img.src = url + sep + '_t=' + Date.now().toString(36);
        });
    }

    /* ============================================================
     * Sample recording
     * ============================================================ */
    function recordSample(result) {
        var i = state.nextIndex++;
        state.samples.push({
            i: i,
            t: Date.now(),
            ms: result.ms,
            ok: result.ok
        });
        if (state.samples.length > CONFIG.MAX_SAMPLES) {
            state.samples.shift();
        }

        if (state.chart && state.dataTable) {
            if (state.dataTable.getNumberOfRows() >= CONFIG.MAX_SAMPLES) {
                state.dataTable.removeRow(0);
            }
            state.dataTable.addRow([i, result.ms]);
            state.chart.draw(state.dataTable, chartOptions());
        }

        updateStatsUI();
        updateButtonStates();
    }

    /* ============================================================
     * Statistics
     * ============================================================ */
    function computeStats() {
        var n = state.samples.length;
        if (n === 0) { return null; }

        var values = state.samples.map(function (s) { return s.ms; }).sort(function (a, b) { return a - b; });
        var sum = values.reduce(function (acc, v) { return acc + v; }, 0);
        var avg = sum / n;

        function percentile(q) {
            var idx = clamp(Math.ceil((q / 100) * n) - 1, 0, n - 1);
            return values[idx];
        }

        var jitter = 0;
        if (n > 1) {
            var acc = 0;
            for (var k = 1; k < n; k++) {
                acc += Math.abs(state.samples[k].ms - state.samples[k - 1].ms);
            }
            jitter = acc / (n - 1);
        }

        return {
            count:  n,
            last:   state.samples[n - 1].ms,
            min:    values[0],
            max:    values[n - 1],
            avg:    avg,
            p50:    percentile(50),
            p95:    percentile(95),
            p99:    percentile(99),
            jitter: jitter
        };
    }

    function updateStatsUI() {
        var s = computeStats();
        if (!s) {
            ['ping', 'last', 'high', 'low', 'avg', 'p50', 'p95', 'p99', 'jitter']
                .forEach(function (key) { els[key].textContent = '—'; });
            els.count.textContent = '0';
            return;
        }
        els.ping.textContent   = fmtMs(s.last);
        els.last.textContent   = fmtMs(s.last);
        els.high.textContent   = fmtMs(s.max);
        els.low.textContent    = fmtMs(s.min);
        els.avg.textContent    = fmtMs(s.avg);
        els.p50.textContent    = fmtMs(s.p50);
        els.p95.textContent    = fmtMs(s.p95);
        els.p99.textContent    = fmtMs(s.p99);
        els.jitter.textContent = fmtMs(s.jitter);
        els.count.textContent  = String(s.count);
    }

    /* ============================================================
     * Chart
     * ============================================================ */
    function chartOptions() {
        return {
            chart: {
                title:    'Latency (ms)',
                subtitle: 'favicon load time — not ICMP'
            },
            hAxis: { title: 'Sample', minValue: 0 },
            vAxis: { title: 'ms',     minValue: 0 },
            legend: { position: 'none' },
            chartArea: { width: '85%', height: '70%' },
            backgroundColor: { fill: 'transparent' },
            colors: ['#0d6efd']
        };
    }

    function initChart() {
        state.dataTable = new google.visualization.DataTable();
        state.dataTable.addColumn('number', 'Sample');
        state.dataTable.addColumn('number', 'ms');
        state.chart = new google.charts.Line(els.chart);
        state.chart.draw(state.dataTable, chartOptions());
    }

    /* ============================================================
     * Actions
     * ============================================================ */
    function validateAddress() {
        var url = (els.address.value || '').trim();
        if (!/^https?:\/\//i.test(url)) {
            setStatus('Address must start with http:// or https://', 'warning');
            return null;
        }
        return url;
    }

    function testOnce() {
        if (state.inFlight || !state.chart) { return; }
        var url = validateAddress();
        if (!url) { return; }

        state.inFlight = true;
        updateButtonStates();
        setStatus('Probing…', 'info');

        pingOnce(url).then(function (result) {
            recordSample(result);
            if (result.ok) {
                setStatus('OK — ' + fmtMs(result.ms) + ' ms', 'success');
            } else {
                setStatus('Failed (network error or timeout)', 'danger');
            }
        }).catch(function (err) {
            setStatus('Error: ' + err.message, 'danger');
        }).finally(function () {
            state.inFlight = false;
            updateButtonStates();
        });
    }

    function readIntervalMs() {
        var raw = parseInt(els.time.value, 10);
        if (!Number.isFinite(raw) || raw < CONFIG.MIN_INTERVAL_MS) { raw = CONFIG.MIN_INTERVAL_MS; }
        if (raw > CONFIG.MAX_INTERVAL_MS) { raw = CONFIG.MAX_INTERVAL_MS; }
        els.time.value = raw;
        return raw;
    }

    function startLoop() {
        if (state.running || !state.chart) { return; }
        var interval = readIntervalMs();
        saveSettings();

        state.running = true;
        setStatus('Running', 'success');
        updateButtonStates();

        testOnce();                                  // fire immediately
        state.intervalId = setInterval(testOnce, interval);
    }

    function stopLoop() {
        if (!state.running) { return; }
        state.running = false;
        if (state.intervalId !== null) {
            clearInterval(state.intervalId);
            state.intervalId = null;
        }
        setStatus('Stopped', 'secondary');
        updateButtonStates();
    }

    function resetAll() {
        if (state.running) { return; }
        state.samples   = [];
        state.nextIndex = 1;
        if (state.chart && state.dataTable) {
            state.dataTable.removeRows(0, state.dataTable.getNumberOfRows());
            state.chart.draw(state.dataTable, chartOptions());
        }
        updateStatsUI();
        setStatus('Idle', 'secondary');
        updateButtonStates();
    }

    function exportCsv() {
        if (state.samples.length === 0) { return; }
        var rows = [['sample', 'timestamp_iso', 'ms', 'ok']];
        state.samples.forEach(function (s) {
            rows.push([
                s.i,
                new Date(s.t).toISOString(),
                s.ms.toFixed(1),
                s.ok ? '1' : '0'
            ]);
        });
        var csv  = rows.map(function (r) { return r.join(','); }).join('\n');
        var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        var url  = URL.createObjectURL(blob);
        var a    = document.createElement('a');
        a.href = url;
        a.download = 'ping-' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /* ============================================================
     * Event wiring
     * ============================================================ */
    function wireEvents() {
        els.test.addEventListener('click', testOnce);
        els.start.addEventListener('click', startLoop);
        els.stop.addEventListener('click', stopLoop);
        els.reset.addEventListener('click', resetAll);
        els.exportBtn.addEventListener('click', exportCsv);

        /* Live interval change: apply while running without restarting. */
        els.time.addEventListener('input', function () {
            saveSettings();
            if (!state.running) { return; }
            clearInterval(state.intervalId);
            state.intervalId = setInterval(testOnce, readIntervalMs());
        });

        els.address.addEventListener('change', saveSettings);

        /* Preset buttons. */
        Array.prototype.forEach.call(
            document.querySelectorAll('.setaddress'),
            function (btn) {
                btn.addEventListener('click', function () {
                    els.address.value = btn.dataset.address || '';
                    saveSettings();
                    if (!state.running) { resetAll(); }
                });
            }
        );

        /* Keyboard shortcuts (ignored while typing in an input). */
        document.addEventListener('keydown', function (e) {
            var tag = (e.target && e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea') { return; }

            if (e.code === 'Space') {
                e.preventDefault();
                state.running ? stopLoop() : startLoop();
            } else if (e.code === 'Escape' && state.running) {
                stopLoop();
            } else if (e.code === 'KeyR' && !state.running) {
                resetAll();
            }
        });

        /* Pause loop when tab goes hidden. */
        document.addEventListener('visibilitychange', function () {
            if (document.hidden && state.running) {
                stopLoop();
                setStatus('Paused (tab hidden)', 'warning');
            }
        });

        /* Clean up on unload. */
        window.addEventListener('beforeunload', function () {
            if (state.intervalId !== null) { clearInterval(state.intervalId); }
        });
    }

    /* ============================================================
     * Boot
     * ============================================================ */
    function boot() {
        loadSettings();
        wireEvents();
        updateStatsUI();
        updateButtonStates();

        if (!window.google || !window.google.charts) {
            setStatus('Google Charts failed to load', 'danger');
            return;
        }

        google.charts.load('current', { packages: ['line'] });
        google.charts.setOnLoadCallback(function () {
            initChart();
            setStatus('Idle', 'secondary');
            updateButtonStates();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
