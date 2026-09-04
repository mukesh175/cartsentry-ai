/**
 * CartSentry AI — storefront warning renderer.
 *
 * Deliberately tiny and dependency-free. This runs on every shopper's cart page,
 * so the budget is a few kilobytes and one cached network request — no
 * framework, no polyfills, no analytics, no admin code.
 *
 * It only *displays* warnings. Rules are enforced server-side by the Cart and
 * Checkout Validation Function, so a shopper who blocks this script, clears
 * storage, or edits the DOM gains nothing at checkout.
 */
(function () {
  "use strict";

  var CACHE_KEY = "cartsentry:warnings:v1";
  var CACHE_TTL_MS = 5 * 60 * 1000;

  function readCache() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || Date.now() - parsed.at > CACHE_TTL_MS) return null;
      return parsed.data;
    } catch (error) {
      // Private browsing and blocked storage both throw here. Not an error
      // worth surfacing — just fetch fresh.
      return null;
    }
  }

  function writeCache(data) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data: data }));
    } catch (error) {
      /* storage unavailable; caching is an optimisation, not a requirement */
    }
  }

  function fetchConfig(proxyUrl) {
    var cached = readCache();
    if (cached) return Promise.resolve(cached);

    return fetch(proxyUrl, { headers: { accept: "application/json" } })
      .then(function (response) {
        if (!response.ok) throw new Error("proxy " + response.status);
        return response.json();
      })
      .then(function (data) {
        writeCache(data);
        return data;
      });
  }

  function fetchCart() {
    return fetch(window.Shopify && window.Shopify.routes
      ? window.Shopify.routes.root + "cart.js"
      : "/cart.js", { headers: { accept: "application/json" } })
      .then(function (response) {
        if (!response.ok) throw new Error("cart " + response.status);
        return response.json();
      });
  }

  /**
   * Evaluate the compact warning rules against the Shopify cart.
   *
   * A deliberately reduced subset of the full engine: only the conditions that
   * can be checked from cart.js alone. Anything needing customer tags, order
   * history or a delivery address is skipped here and left to the server, so
   * this script never shows a warning it cannot actually justify.
   */
  function evaluate(rules, cart) {
    var messages = [];

    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      var conditions = rule.conditions || [];
      var results = [];

      for (var j = 0; j < conditions.length; j++) {
        var outcome = evaluateCondition(conditions[j], cart);
        if (outcome === null) {
          // Not determinable on the storefront. Abandon this rule entirely
          // rather than guessing.
          results = null;
          break;
        }
        results.push(outcome);
      }

      if (!results || results.length === 0) continue;

      var matched =
        rule.logic === "OR"
          ? results.indexOf(true) !== -1
          : results.indexOf(false) === -1;

      if (rule.negate) matched = !matched;
      if (matched) messages.push({ title: rule.title, message: rule.message, severity: rule.severity });
    }

    return messages;
  }

  function evaluateCondition(condition, cart) {
    var actual;

    switch (condition.kind) {
      case "product_quantity":
        actual = quantityOfProduct(cart, condition.productId, condition.variantId);
        return compare(actual, condition.operator, condition.value);

      case "cart_quantity":
        return compare(cart.item_count, condition.operator, condition.value);

      case "cart_subtotal":
        // cart.js reports money in cents; rule values are in major units.
        return compare(cart.items_subtotal_price, condition.operator, Math.round(condition.value * 100));

      case "product_present":
        actual = quantityOfProduct(cart, condition.productId) > 0;
        return actual === condition.present;

      default:
        // Customer tags, order counts, countries, currencies and collections
        // are not reliably knowable here.
        return null;
    }
  }

  function quantityOfProduct(cart, productId, variantId) {
    var total = 0;
    for (var i = 0; i < cart.items.length; i++) {
      var item = cart.items[i];
      if (variantId) {
        if (String(item.variant_id) === String(variantId)) total += item.quantity;
      } else if (String(item.product_id) === String(productId)) {
        total += item.quantity;
      }
    }
    return total;
  }

  function compare(actual, operator, expected) {
    switch (operator) {
      case "gt":
        return actual > expected;
      case "gte":
        return actual >= expected;
      case "lt":
        return actual < expected;
      case "lte":
        return actual <= expected;
      case "eq":
        return actual === expected;
      case "neq":
        return actual !== expected;
      default:
        return null;
    }
  }

  function render(root, messages) {
    var list = root.querySelector(".cartsentry-warnings__list");
    if (!list) return;

    list.textContent = "";

    if (messages.length === 0) {
      root.hidden = true;
      return;
    }

    for (var i = 0; i < messages.length; i++) {
      var entry = messages[i];
      var item = document.createElement("div");
      item.className = "cartsentry-warning cartsentry-warning--" + (entry.severity || "warning");

      if (entry.title) {
        var title = document.createElement("strong");
        title.className = "cartsentry-warning__title";
        // textContent, never innerHTML: merchant copy is data, not markup.
        title.textContent = entry.title;
        item.appendChild(title);
      }

      var body = document.createElement("span");
      body.className = "cartsentry-warning__message";
      body.textContent = entry.message;
      item.appendChild(body);

      list.appendChild(item);
    }

    root.hidden = false;
  }

  function refresh(root) {
    Promise.all([fetchConfig(root.dataset.proxy), fetchCart()])
      .then(function (results) {
        var config = results[0];
        var cart = results[1];
        if (!config || !config.rules || config.rules.length === 0) {
          root.hidden = true;
          return;
        }
        render(root, evaluate(config.rules, cart));
      })
      .catch(function () {
        // A warning we cannot compute is simply not shown. The customer is
        // never blocked by this script, and checkout enforcement is unaffected.
        root.hidden = true;
      });
  }

  function init() {
    var roots = document.querySelectorAll("[data-cartsentry]");
    for (var i = 0; i < roots.length; i++) {
      (function (root) {
        refresh(root);

        // Themes dispatch varying events on cart change; listen broadly but
        // debounce so a quantity stepper does not cause a burst of requests.
        var timer = null;
        var schedule = function () {
          clearTimeout(timer);
          timer = setTimeout(function () {
            refresh(root);
          }, 300);
        };

        document.addEventListener("cart:updated", schedule);
        document.addEventListener("cart:refresh", schedule);
        document.addEventListener("cart:change", schedule);
      })(roots[i]);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
