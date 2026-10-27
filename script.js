"use strict";

/* ==========================================================
   Student Wellbeing Predictor — frontend logic
   ========================================================== */

/* ---------- Configuration ---------- */

// Address of your FastAPI server (uvicorn main:app --reload)
const API_BASE_URL = "http://127.0.0.1:5500";

const REQUEST_TIMEOUT_MS = 15000; // give up on /predict after 15 s
const STATUS_TIMEOUT_MS = 4000;   // give up on the health check after 4 s
const MIN_LOADING_MS = 500;       // keep the loading state visible long enough to notice

// The gauge assumes a 0–10 scale where a higher score means better wellbeing.
// If your model uses a different range, change SCORE_MAX and the bands in getBand().
const SCORE_MAX = 10;

/* ---------- DOM references ---------- */

const form = document.getElementById("predict-form");
const submitBtn = document.getElementById("submit-btn");
const submitLabel = document.getElementById("submit-label");
const resetBtn = document.getElementById("reset-btn");
const formError = document.getElementById("form-error");

const panel = document.getElementById("result-panel");
const scoreValue = document.getElementById("score-value");
const gaugeFill = document.getElementById("gauge-fill");
const bandTitle = document.getElementById("band-title");
const bandText = document.getElementById("band-text");
const chipList = document.getElementById("chips");

const apiStatus = document.getElementById("api-status");
const apiStatusText = document.getElementById("api-status-text");

/* ---------- Validation rules (mirror the Pydantic model) ---------- */

const hoursRule = (v) =>
  v !== "" && Number(v) >= 0 && Number(v) <= 24 ? "" : "Enter hours between 0 and 24.";

const choiceRule = (v) => (v ? "" : "Choose an option.");

const rules = {
  age: (v) =>
    v !== "" && Number.isInteger(Number(v)) && Number(v) >= 10 && Number(v) <= 100
      ? ""
      : "Enter a whole number between 10 and 100.",
  gender: choiceRule,
  country: (v) => (v ? "" : "Enter a country."),
  academic_level: choiceRule,
  most_used_platform: choiceRule,
  purpose_of_use: choiceRule,
  avg_daily_usage_hours: hoursRule,
  daily_unlocks: (v) =>
    v !== "" && Number.isInteger(Number(v)) && Number(v) >= 0
      ? ""
      : "Enter a whole number, 0 or higher.",
  study_hours: hoursRule,
  physical_activity_hours: hoursRule,
  sleep_hours_per_night: hoursRule,
  stress_level: choiceRule,
};

/* ---------- Small helpers ---------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

class ApiError extends Error {
  constructor(status, body) {
    super(`API responded with status ${status}`);
    this.status = status;
    this.body = body;
  }
}

function getValues() {
  const data = new FormData(form);
  const values = {};
  for (const name of Object.keys(rules)) {
    values[name] = (data.get(name) ?? "").toString().trim();
  }
  return values;
}

// Convert the form strings into the types the Pydantic model expects.
function buildPayload(values) {
  return {
    age: parseInt(values.age, 10),
    gender: values.gender,
    country: values.country,
    academic_level: values.academic_level,
    most_used_platform: values.most_used_platform,
    purpose_of_use: values.purpose_of_use,
    avg_daily_usage_hours: parseFloat(values.avg_daily_usage_hours),
    daily_unlocks: parseInt(values.daily_unlocks, 10),
    study_hours: parseFloat(values.study_hours),
    physical_activity_hours: parseFloat(values.physical_activity_hours),
    sleep_hours_per_night: parseFloat(values.sleep_hours_per_night),
    stress_level: values.stress_level,
  };
}

/* ---------- Error display ---------- */

function setFieldError(name, message) {
  const wrapper = form.querySelector(`[data-field="${name}"]`);
  if (!wrapper) return false;

  wrapper.querySelector(".error").textContent = message;
  wrapper.classList.toggle("has-error", Boolean(message));
  wrapper
    .querySelectorAll("input, select")
    .forEach((el) => el.setAttribute("aria-invalid", message ? "true" : "false"));
  return true;
}

function clearAllErrors() {
  Object.keys(rules).forEach((name) => setFieldError(name, ""));
  hideFormError();
}

function showFormError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function hideFormError() {
  formError.hidden = true;
  formError.textContent = "";
}

function focusFirstError() {
  const firstInvalid = form.querySelector(".has-error");
  if (firstInvalid) firstInvalid.querySelector("input, select")?.focus();
}

/* ---------- Validation ---------- */

function validate(values) {
  let valid = true;

  for (const [name, rule] of Object.entries(rules)) {
    const message = rule(values[name]);
    setFieldError(name, message);
    if (message) valid = false;
  }

  // Sanity check: study + activity + sleep can't exceed a day.
  if (valid) {
    const total =
      Number(values.study_hours) +
      Number(values.physical_activity_hours) +
      Number(values.sleep_hours_per_night);
    if (total > 24) {
      setFieldError(
        "sleep_hours_per_night",
        "Study, activity and sleep add up to more than 24 hours."
      );
      valid = false;
    }
  }

  if (!valid) focusFirstError();
  return valid;
}

/* ---------- API calls ---------- */

async function requestPrediction(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE_URL}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    let body = null;
    try {
      body = await response.json();
    } catch {
      /* response had no JSON body */
    }

    if (!response.ok) throw new ApiError(response.status, body);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function setApiStatus(state) {
  const labels = {
    checking: "Checking API…",
    online: "API connected",
    offline: "API offline",
  };
  apiStatus.dataset.state = state;
  apiStatusText.textContent = labels[state];
}

async function checkApi() {
  setApiStatus("checking");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE_URL}/`, { signal: controller.signal });
    setApiStatus(response.ok ? "online" : "offline");
  } catch {
    setApiStatus("offline");
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Result panel ---------- */

let countToken = 0; // lets a new run cancel an in-progress count-up

function getBand(score) {
  if (score >= 7) {
    return {
      key: "good",
      title: "Doing well",
      text: "The model predicts a healthy score for this profile.",
    };
  }
  if (score >= 5) {
    return {
      key: "moderate",
      title: "Moderate",
      text: "The model predicts a middling score for this profile.",
    };
  }
  return {
    key: "low",
    title: "Needs attention",
    text: "The model predicts a lower score. If this reflects a real student who is struggling, a conversation with a counsellor or doctor is worthwhile.",
  };
}

function buildChips(payload) {
  return [
    `${payload.avg_daily_usage_hours} h/day on ${payload.most_used_platform}`,
    `${payload.sleep_hours_per_night} h sleep`,
    `${payload.physical_activity_hours} h activity`,
    `${payload.stress_level} stress`,
  ];
}

function showIdle() {
  countToken++;
  gaugeFill.style.strokeDasharray = "";
  scoreValue.textContent = "–";
  delete panel.dataset.band;
  panel.dataset.state = "idle";
}

function showLoading() {
  countToken++;
  gaugeFill.style.strokeDasharray = "";
  scoreValue.textContent = "…";
  panel.dataset.state = "loading";
}

function countUp(target) {
  const id = ++countToken;

  if (prefersReducedMotion()) {
    scoreValue.textContent = target.toFixed(2);
    return;
  }

  const start = performance.now();
  const duration = 1000;

  const tick = (now) => {
    if (id !== countToken) return; // a newer run took over
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    scoreValue.textContent = (target * eased).toFixed(2);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function showResult(score, payload) {
  const percent = Math.max(0, Math.min(score / SCORE_MAX, 1)) * 100;
  const band = getBand(score);

  bandTitle.textContent = band.title;
  bandText.textContent = band.text;
  chipList.replaceChildren(
    ...buildChips(payload).map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    })
  );
  panel.dataset.band = band.key;

  // Start the arc from empty, then let the CSS transition draw it.
  gaugeFill.style.strokeDasharray = "0 100";
  void gaugeFill.getBoundingClientRect();
  panel.dataset.state = "result";
  void gaugeFill.getBoundingClientRect();
  gaugeFill.style.strokeDasharray = `${percent} 100`;

  countUp(score);

  // On narrow screens the result sits below the form, so bring it into view.
  if (window.innerWidth < 960) {
    panel.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  }
}

/* ---------- Loading state for the button ---------- */

function setSubmitting(isSubmitting) {
  submitBtn.disabled = isSubmitting;
  submitBtn.classList.toggle("is-loading", isSubmitting);
  submitLabel.textContent = isSubmitting ? "Predicting…" : "Predict score";
  form.setAttribute("aria-busy", String(isSubmitting));
}

/* ---------- Error handling ---------- */

function handleError(error) {
  // The API answered, but with an error status.
  if (error instanceof ApiError) {
    if (error.status === 422 && Array.isArray(error.body?.detail)) {
      error.body.detail.forEach((item) => {
        const field = Array.isArray(item.loc) ? item.loc[item.loc.length - 1] : null;
        setFieldError(field, item.msg || "This value was rejected by the server.");
      });
      showFormError("The server rejected some values. Review the highlighted fields and try again.");
      focusFirstError();
      return;
    }
    showFormError(
      `The API returned an error (${error.status}). Check the uvicorn terminal for details.`
    );
    return;
  }

  // The request took too long.
  if (error.name === "AbortError") {
    showFormError(
      "The request timed out after 15 seconds. Check that the server is running and the model has loaded."
    );
    setApiStatus("offline");
    return;
  }

  // The browser could not reach the server at all.
  if (error instanceof TypeError) {
    showFormError(
      `Could not reach the API at ${API_BASE_URL}. Start it with "uvicorn main:app --reload" and try again.`
    );
    setApiStatus("offline");
    return;
  }

  showFormError(error.message || "Something went wrong. Please try again.");
}

/* ---------- Event wiring ---------- */

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideFormError();

  const values = getValues();
  if (!validate(values)) return;

  const payload = buildPayload(values);

  setSubmitting(true);
  showLoading();

  try {
    const [result] = await Promise.all([requestPrediction(payload), sleep(MIN_LOADING_MS)]);

    const score = Number(result?.predicted_mental_health_score);
    if (!Number.isFinite(score)) {
      throw new Error("The API replied, but the response did not include a score.");
    }

    setApiStatus("online");
    showResult(score, payload);
  } catch (error) {
    showIdle();
    handleError(error);
  } finally {
    setSubmitting(false);
  }
});

// Clear a field's error as soon as the user edits it.
form.addEventListener("input", (event) => {
  const name = event.target.name;
  if (name && rules[name]) setFieldError(name, "");
  hideFormError();
});

resetBtn.addEventListener("click", () => {
  form.reset();
  clearAllErrors();
  showIdle();
});

apiStatus.addEventListener("click", checkApi);

checkApi();
