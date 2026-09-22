/* Ferminux Network — public site
   Vanilla JS, zero external requests. Talks JSON-RPC to the chain only.
   The pure logic lives on the FMX object so it can be unit-tested in Node
   (`node -e "const FMX = require('./assets/app.js'); ..."`). */

(function (global) {
  'use strict';

  var DEFAULT_RPC = 'https://rpc.ferminux.net';
  var EXPECTED_CHAIN_ID = 3961;
  var POLL_MS = 7000;
  var TAPE_SEED = 18;   /* headers fetched for the block tape on first sync */
  var BUFFER_MAX = 40;

  /* Exact params from wallet/metamask-add-network.json */
  var ADD_CHAIN_PARAMS = {
    chainId: '0xF79',
    chainName: 'Ferminux Network',
    nativeCurrency: { name: 'Ferminux', symbol: 'FMX', decimals: 18 },
    rpcUrls: ['https://rpc.ferminux.net'],
    blockExplorerUrls: ['https://explorer.ferminux.net']
  };

  /* FMX/AZNT pair on the Ferminux DEX. token0 = wrapped FMX (18 decimals),
     token1 = AZNT (6 decimals) — the ordering is fixed at pair creation and
     was verified against the live contract. */
  var PAIR_ADDRESS = '0xbab12e7B817F0686e11949eC06697235DC146845';
  var SEL_GET_RESERVES = '0x0902f1ac';

  var FMX = {
    DEFAULT_RPC: DEFAULT_RPC,
    EXPECTED_CHAIN_ID: EXPECTED_CHAIN_ID,
    ADD_CHAIN_PARAMS: ADD_CHAIN_PARAMS,
    PAIR_ADDRESS: PAIR_ADDRESS,

    /* Resolve the RPC endpoint: ?rpc=<url> query override (http/https only)
       beats the data-rpc attribute, which beats the production default. */
    resolveRpc: function (search, dataAttr) {
      try {
        var override = new URLSearchParams(search || '').get('rpc');
        if (override && /^https?:\/\//i.test(override)) return override;
      } catch (e) { /* older engines: fall through */ }
      return dataAttr || DEFAULT_RPC;
    },

    buildStatsRequest: function () {
      return [
        { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
        { jsonrpc: '2.0', id: 2, method: 'eth_getBlockByNumber', params: ['latest', false] },
        { jsonrpc: '2.0', id: 3, method: 'eth_chainId', params: [] },
        { jsonrpc: '2.0', id: 4, method: 'eth_call',
          params: [{ to: PAIR_ADDRESS, data: SEL_GET_RESERVES }, 'latest'] }
      ];
    },

    parseStatsResponse: function (json) {
      var byId = {};
      (Array.isArray(json) ? json : [json]).forEach(function (r) {
        if (r && r.id != null) byId[r.id] = r;
      });
      var height = byId[1] && byId[1].result ? parseInt(byId[1].result, 16) : null;
      var block = byId[2] && byId[2].result ? byId[2].result : null;
      var baseFeeWei = block && block.baseFeePerGas ? parseInt(block.baseFeePerGas, 16) : null;
      var chainId = byId[3] && byId[3].result ? parseInt(byId[3].result, 16) : null;
      var gasLimit = block && block.gasLimit ? parseInt(block.gasLimit, 16) : null;
      return {
        height: Number.isFinite(height) ? height : null,
        baseFeeWei: Number.isFinite(baseFeeWei) ? baseFeeWei : null,
        chainId: Number.isFinite(chainId) ? chainId : null,
        gasLimit: Number.isFinite(gasLimit) ? gasLimit : null,
        priceAznt: FMX.priceFromReserves(byId[4] && byId[4].result)
      };
    },

    /* getReserves() → (uint112 reserve0, uint112 reserve1, uint32 tsLast).
       reserve0 is FMX (1e18), reserve1 AZNT (1e6). Doubles lose integer
       precision above 2^53, but the relative error is far below display
       precision. A missing pair (e.g. a local devnet) returns "0x" → null. */
    priceFromReserves: function (hex) {
      if (typeof hex !== 'string' || hex.slice(0, 2) !== '0x' || hex.length < 130) return null;
      var r0 = parseInt(hex.slice(2, 66), 16);
      var r1 = parseInt(hex.slice(66, 130), 16);
      if (!isFinite(r0) || !isFinite(r1) || r0 <= 0 || r1 < 0) return null;
      return (r1 / 1e6) / (r0 / 1e18);
    },

    formatPrice: function (p) {
      if (p == null || !isFinite(p)) return '—';
      if (p >= 100) return p.toFixed(1);
      if (p >= 1) return p.toFixed(3);
      if (p >= 0.01) return p.toFixed(4);
      return p.toPrecision(3);
    },

    formatHeight: function (height) {
      if (height == null) return '—';
      return height.toLocaleString('en-US');
    },

    /* Base fee arrives in wei. Empty blocks decay it far below 1 gwei,
       so pick the unit by magnitude. */
    formatBaseFee: function (wei) {
      if (wei == null) return '—';
      if (wei < 1e6) return wei.toLocaleString('en-US') + ' wei';
      var gwei = wei / 1e9;
      var str = gwei >= 100 ? gwei.toFixed(0)
        : gwei >= 1 ? gwei.toFixed(2)
        : gwei.toFixed(3);
      return str.replace(/\.?0+$/, '') + ' gwei';
    },

    formatGasLimit: function (n) {
      if (n == null) return '—';
      if (n >= 1e6 && n % 1e5 === 0) {
        return String(n / 1e6).replace(/\.0$/, '') + 'M';
      }
      return n.toLocaleString('en-US');
    },

    formatInterval: function (s) {
      if (s == null || !isFinite(s)) return '—';
      return (s >= 10 ? s.toFixed(0) : s.toFixed(1)) + ' s';
    },

    formatHashrate: function (hs) {
      if (hs == null || !isFinite(hs) || hs <= 0) return '—';
      var units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
      var i = 0;
      while (hs >= 1000 && i < units.length - 1) { hs /= 1000; i++; }
      var str = hs >= 100 ? hs.toFixed(0) : hs >= 10 ? hs.toFixed(1) : hs.toFixed(2);
      return str + ' ' + units[i];
    },

    /* Batch of header requests for the block tape (ids = block numbers). */
    buildBlocksRequest: function (from, to) {
      var reqs = [];
      for (var n = from; n <= to; n++) {
        reqs.push({
          jsonrpc: '2.0', id: n, method: 'eth_getBlockByNumber',
          params: ['0x' + n.toString(16), false]
        });
      }
      return reqs;
    },

    parseBlocksResponse: function (json) {
      var out = [];
      (Array.isArray(json) ? json : [json]).forEach(function (r) {
        var b = r && r.result;
        if (!b || !b.number || !b.timestamp) return;
        out.push({
          number: parseInt(b.number, 16),
          timestamp: parseInt(b.timestamp, 16),
          difficulty: b.difficulty ? parseInt(b.difficulty, 16) : null,
          txns: Array.isArray(b.transactions) ? b.transactions.length : 0
        });
      });
      out.sort(function (a, b) { return a.number - b.number; });
      return out;
    },

    /* Average seal interval and estimated network hashrate over a window of
       consecutive headers: hashrate ≈ mean(difficulty) / mean(interval). */
    chainVitals: function (blocks) {
      if (!blocks || blocks.length < 3) return { avgInterval: null, hashrate: null };
      var span = blocks[blocks.length - 1].timestamp - blocks[0].timestamp;
      if (span <= 0) return { avgInterval: null, hashrate: null };
      var avgInterval = span / (blocks.length - 1);
      var dsum = 0, dcount = 0;
      blocks.forEach(function (b) {
        if (b.difficulty != null && isFinite(b.difficulty)) { dsum += b.difficulty; dcount++; }
      });
      return {
        avgInterval: avgInterval,
        hashrate: dcount ? (dsum / dcount) / avgInterval : null
      };
    },

    /* POST a JSON-RPC batch and return the parsed body. fetchImpl is
       injectable so Node tests exercise the identical code path. */
    rpcBatch: function (rpcUrl, body, fetchImpl) {
      var doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
      if (!doFetch) return Promise.reject(new Error('fetch unavailable'));
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, 5000) : null;
      return doFetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).finally(function () {
        if (timer) clearTimeout(timer);
      });
    },

    fetchStats: function (rpcUrl, fetchImpl) {
      return FMX.rpcBatch(rpcUrl, FMX.buildStatsRequest(), fetchImpl)
        .then(FMX.parseStatsResponse);
    },

    fetchBlocks: function (rpcUrl, from, to, fetchImpl) {
      return FMX.rpcBatch(rpcUrl, FMX.buildBlocksRequest(from, to), fetchImpl)
        .then(FMX.parseBlocksResponse);
    }
  };

  /* Node (unit tests) — export and stop before touching the DOM. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = FMX;
    return;
  }
  global.FMX = FMX;

  /* ---------- Browser wiring ---------- */

  document.addEventListener('DOMContentLoaded', function () {

    var rpcUrl = FMX.resolveRpc(location.search, document.body.getAttribute('data-rpc'));
    var $ = function (id) { return document.getElementById(id); };
    var el = {
      dot: $('rpc-dot'),
      status: $('stat-status'),
      height: $('stat-height'),
      baseFee: $('stat-basefee'),
      chainId: $('stat-chainid'),
      price: $('stat-price'),
      hashrate: $('stat-hashrate'),
      blocktime: $('stat-blocktime'),
      gasLimit: $('stat-gaslimit'),
      dexPrice: $('dex-price'),
      dexPriceBlock: $('dex-price-block'),
      tape: $('block-tape'),
      tapeCaption: $('tape-caption')
    };

    var state = {
      blocks: [],          /* ascending header buffer for the tape */
      lastHeight: null,    /* last rendered height (drives the pulse) */
      animatedFor: null    /* newest block number the pop animation ran for */
    };

    function head() {
      return state.blocks.length ? state.blocks[state.blocks.length - 1].number : null;
    }

    function mergeBlocks(fresh) {
      var byNum = {};
      state.blocks.concat(fresh).forEach(function (b) { byNum[b.number] = b; });
      state.blocks = Object.keys(byNum)
        .map(Number)
        .sort(function (a, b) { return a - b; })
        .map(function (n) { return byNum[n]; })
        .slice(-BUFFER_MAX);
    }

    /* ----- Live stats rendering ----- */

    function pulseHeight() {
      if (!el.height) return;
      el.height.classList.remove('pulse');
      void el.height.offsetWidth; /* restart the animation */
      el.height.classList.add('pulse');
    }

    function renderOnline(stats, vitals) {
      el.dot.className = 'status-dot is-online';
      el.status.textContent = 'live';
      el.height.classList.remove('is-offline');
      el.height.textContent = FMX.formatHeight(stats.height);
      if (stats.height != null && state.lastHeight != null && stats.height > state.lastHeight) {
        pulseHeight();
      }
      if (stats.height != null) state.lastHeight = stats.height;

      el.baseFee.textContent = FMX.formatBaseFee(stats.baseFeeWei);
      if (el.gasLimit) {
        el.gasLimit.textContent = FMX.formatGasLimit(stats.gasLimit);
        el.gasLimit.title = stats.gasLimit != null ? stats.gasLimit.toLocaleString('en-US') : '';
      }
      if (stats.chainId != null) {
        el.chainId.textContent = String(stats.chainId);
        el.chainId.className = 'lb-value num' +
          (stats.chainId === FMX.EXPECTED_CHAIN_ID ? '' : ' is-warn');
        el.chainId.title = stats.chainId === FMX.EXPECTED_CHAIN_ID
          ? '' : 'Unexpected chain ID (expected 3961)';
      }

      var price = FMX.formatPrice(stats.priceAznt);
      if (el.price) el.price.textContent = price;
      if (el.dexPrice) el.dexPrice.textContent = price;
      if (el.dexPriceBlock && stats.height != null) {
        el.dexPriceBlock.textContent = 'at block ' + FMX.formatHeight(stats.height);
      }

      if (el.hashrate) el.hashrate.textContent = FMX.formatHashrate(vitals.hashrate);
      if (el.blocktime) el.blocktime.textContent = FMX.formatInterval(vitals.avgInterval);
    }

    function renderOffline() {
      el.dot.className = 'status-dot is-offline';
      el.status.textContent = 'unreachable';
      el.height.classList.add('is-offline');
      /* keep last-known values on screen; show dashes only before first data */
      if (el.height.textContent === '') el.height.textContent = '—';
    }

    /* ----- Block tape (the live SVG) ----- */

    var SVG_NS = 'http://www.w3.org/2000/svg';
    var TAPE_H = 48, BLOCK = 22, BLOCK_Y = 16;

    function svgEl(name, attrs, cls) {
      var node = document.createElementNS(SVG_NS, name);
      for (var k in attrs) node.setAttribute(k, attrs[k]);
      if (cls) node.setAttribute('class', cls);
      return node;
    }

    function renderTape() {
      if (!el.tape || state.blocks.length === 0) return;
      var width = el.tape.parentElement.clientWidth;
      if (!width || width < BLOCK * 2) return;

      while (el.tape.firstChild) el.tape.removeChild(el.tape.firstChild);
      el.tape.setAttribute('viewBox', '0 0 ' + width + ' ' + TAPE_H);

      /* Place blocks right (newest) to left; link length ∝ seal interval. */
      var blocks = state.blocks;
      var placed = [];
      var x = width - BLOCK - 2;
      for (var i = blocks.length - 1; i >= 0 && x >= 0; i--) {
        placed.push({ b: blocks[i], x: x });
        if (i > 0) {
          var dt = Math.max(0, blocks[i].timestamp - blocks[i - 1].timestamp);
          placed[placed.length - 1].dt = dt;
          var gap = Math.min(80, Math.max(14, dt * 6));
          placed[placed.length - 1].gap = gap;
          x -= gap + BLOCK;
        }
      }
      placed.reverse(); /* ascending */

      var midY = BLOCK_Y + BLOCK / 2;
      for (var j = 0; j < placed.length; j++) {
        var p = placed[j];
        var isNewest = j === placed.length - 1;

        if (j > 0) {
          /* link from the previous block to this one */
          var prev = placed[j - 1];
          el.tape.appendChild(svgEl('line', {
            x1: prev.x + BLOCK, y1: midY, x2: p.x, y2: midY
          }, 'tape-link'));
          if (prev.gap >= 26 && prev.dt != null) {
            el.tape.appendChild(svgEl('text', {
              x: (prev.x + BLOCK + p.x) / 2, y: midY - 7, 'text-anchor': 'middle'
            }, 'tape-dt')).textContent = prev.dt + 's';
          }
        }

        var g = svgEl('g', {}, isNewest
          ? 'tape-new' + (state.animatedFor !== p.b.number ? ' tape-arrived' : '')
          : '');
        g.appendChild(svgEl('rect', {
          x: p.x, y: BLOCK_Y, width: BLOCK, height: BLOCK, rx: 5
        }, 'tape-block'));
        var label = String(p.b.number % 100);
        if (label.length < 2) label = '0' + label;
        var t = svgEl('text', {
          x: p.x + BLOCK / 2, y: midY + 3.5, 'text-anchor': 'middle'
        }, 'tape-block-num');
        t.textContent = label;
        g.appendChild(t);
        var title = svgEl('title', {});
        title.textContent = 'Block ' + FMX.formatHeight(p.b.number) +
          ' · ' + p.b.txns + ' txn' + (p.b.txns === 1 ? '' : 's') +
          (p.dt != null ? ' · sealed ' + p.dt + 's before the next' : '');
        g.appendChild(title);
        el.tape.appendChild(g);
      }

      var newest = placed[placed.length - 1];
      if (newest) state.animatedFor = newest.b.number;

      if (el.tapeCaption) {
        var vitals = FMX.chainVitals(state.blocks);
        el.tapeCaption.textContent = 'The last ' + placed.length +
          ' blocks, drawn from the chain — link length ∝ seconds between blocks' +
          (vitals.avgInterval != null
            ? ' · avg ' + FMX.formatInterval(vitals.avgInterval)
            : '');
      }
    }

    /* ----- Poll loop ----- */

    function syncBlocks(stats) {
      if (stats.height == null) return Promise.resolve();
      var h = head();
      if (h == null || stats.height < h) {
        /* first sync, or the chain reorged below our buffer: reseed */
        var from = Math.max(0, stats.height - TAPE_SEED + 1);
        return FMX.fetchBlocks(rpcUrl, from, stats.height).then(function (bs) {
          state.blocks = bs;
        });
      }
      if (stats.height > h) {
        var start = stats.height - h > TAPE_SEED ? stats.height - TAPE_SEED + 1 : h + 1;
        return FMX.fetchBlocks(rpcUrl, start, stats.height).then(mergeBlocks);
      }
      return Promise.resolve();
    }

    function poll() {
      FMX.fetchStats(rpcUrl).then(function (stats) {
        return syncBlocks(stats)['catch'](function () { /* tape lags a poll */ })
          .then(function () {
            renderOnline(stats, FMX.chainVitals(state.blocks));
            renderTape();
          });
      })['catch'](renderOffline);
    }
    poll();
    setInterval(poll, POLL_MS);

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(renderTape, 150);
    });

    /* ----- Add to MetaMask ----- */

    function setWalletStatus(msg, cls) {
      document.querySelectorAll('.wallet-status').forEach(function (line) {
        line.textContent = msg;
        line.className = 'wallet-status' + (cls ? ' ' + cls : '');
      });
    }

    function addNetwork() {
      if (typeof window.ethereum === 'undefined') {
        setWalletStatus('No wallet detected — add the network manually with the parameters below.', 'is-error');
        var manual = document.getElementById('wallet');
        if (manual) manual.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [ADD_CHAIN_PARAMS]
      }).then(function () {
        setWalletStatus('Ferminux Network added — check your wallet.', 'is-ok');
      })['catch'](function (err) {
        if (err && err.code === 4001) {
          setWalletStatus('Request cancelled in the wallet.', '');
        } else {
          setWalletStatus('Wallet error — add the network manually with the parameters below.', 'is-error');
        }
      });
    }

    var heroBtn = document.getElementById('add-network');
    if (heroBtn) heroBtn.addEventListener('click', addNetwork);
    document.querySelectorAll('[data-add-network]').forEach(function (btn) {
      btn.addEventListener('click', addNetwork);
    });

    /* ----- Quickstart tabs ----- */

    document.querySelectorAll('[data-tabs]').forEach(function (root) {
      var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
      function select(tab) {
        tabs.forEach(function (t) {
          var active = t === tab;
          t.setAttribute('aria-selected', active ? 'true' : 'false');
          t.tabIndex = active ? 0 : -1;
          var panel = document.getElementById(t.getAttribute('aria-controls'));
          if (panel) panel.hidden = !active;
        });
        tab.focus();
      }
      tabs.forEach(function (tab, i) {
        tab.addEventListener('click', function () { select(tab); });
        tab.addEventListener('keydown', function (e) {
          var next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
          if (next === null) return;
          e.preventDefault();
          select(tabs[(next + tabs.length) % tabs.length]);
        });
      });
    });

    /* ----- Copy buttons ----- */

    function copyText(text, done) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done)['catch'](function () {});
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) {}
        document.body.removeChild(ta);
      }
    }

    document.querySelectorAll('[data-copy]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var pre = btn.parentElement.querySelector('pre');
        if (!pre) return;
        copyText(pre.textContent, function () {
          btn.textContent = 'Copied';
          setTimeout(function () { btn.textContent = 'Copy'; }, 1600);
        });
      });
    });

    document.querySelectorAll('[data-copy-text]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        copyText(btn.getAttribute('data-copy-text'), function () {
          btn.textContent = 'copied';
          setTimeout(function () { btn.textContent = 'copy'; }, 1600);
        });
      });
    });
  });

})(typeof window !== 'undefined' ? window : this);
