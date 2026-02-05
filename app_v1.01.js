/*
  File: app_v1.01.js
  App: Focus Compass (ADHD support)
  Version: 1.01

  Changelog (v1.01):
  - Projects redesign with chunking modal (physical/time/energy modes).
  - Clearer Next Step language and project status cues.
  - Added Help screen with feature rationale and ADHD coping tips.
  - Onboarding tooltips, starter routine templates, and task → project conversion.
*/

(() => {
  "use strict";

  const VERSION = "1.01";
  const STORAGE_KEY = "focus_compass_v1";
  const now = () => new Date().toISOString();
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBZn3bOj99GSFvsZGSKctjdz-IrcPos4NM",
    authDomain: "focuscompass-75e44.firebaseapp.com",
    projectId: "focuscompass-75e44",
    storageBucket: "focuscompass-75e44.firebasestorage.app",
    messagingSenderId: "334786606663",
    appId: "1:334786606663:web:f0b02dcde30fd71aa76362",
    measurementId: "G-BSBT6PJ9Q4"
  };
  const FIREBASE_APPCHECK_SITE_KEY = "6Lfv82AsAAAAAAzT8L-DoKtQpZVGvcC9QBiI_Ypy";
  const BACKUP_DEBOUNCE_MS = 30000;

  // ---------- Utilities ----------
  const uid = () => Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const fmtDate = (iso) => {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, { weekday:"short", month:"short", day:"numeric" });
    } catch { return ""; }
  };
  const safeText = (s) => (s || "").toString().trim();
  const normalizeTag = (t) => safeText(t).replace(/\s+/g, " ").trim();
  const normalizeTags = (arr) => {
    const out = [];
    const seen = new Set();
    (arr || []).forEach(t => {
      const tag = normalizeTag(t);
      if(!tag) return;
      const key = tag.toLowerCase();
      if(seen.has(key)) return;
      seen.add(key);
      out.push(tag);
    });
    return out;
  };
  const TAG_PALETTE = [
    "#f59e0b",
    "#ef4444",
    "#10b981",
    "#3b82f6",
    "#8b5cf6",
    "#ec4899",
    "#14b8a6",
    "#22c55e",
    "#6366f1"
  ];
  const hashTag = (tag) => {
    let h = 0;
    for(let i = 0; i < tag.length; i += 1) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
    return h;
  };

  // ---------- Default data ----------
  const defaultState = () => ({
    version: VERSION,
    createdAt: now(),
    onboarding: {
      seen: false
    },
    settings: {
      wipLimit: 3,
      defaultTimerMin: 25,
      lowStim: false,
      nudges: true,
      minimalMode: false,
      toolsCollapsed: true
    },
    tagColors: {},
    activeTagFilter: "all",
    tags: [
      "coding",
      "personal",
      "work",
      "family",
      "tech",
      "tinkering",
      "woodworking",
      "3D printing",
      "laser cutting"
    ],
    // tasks not in priorities live in inbox ("captured")
    tasks: [], // {id,text,status:'open'|'done', createdAt, doneAt?, pinned?:bool, due?:iso, projectId?, tags?:string[]}
    priorities: [], // array of task ids
    nextStepTaskId: null,
    projects: [], // {id,name,why,doneDef, createdAt, archived?:bool, tags?:string[]}
    routines: [], // {id,name,steps:[string], createdAt}
    wins: [], // {id,text,createdAt}
    interruptions: [] // {id,text,createdAt, resolved?:bool}
  });

  const load = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return { ...defaultState(), ...parsed, settings: { ...defaultState().settings, ...(parsed.settings||{}) } };
    } catch {
      return defaultState();
    }
  };

  const save = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    scheduleBackup();
  };

  // ---------- DOM helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const el = (tag, attrs={}, children=[]) => {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([k,v]) => {
      if(k === "class") node.className = v;
      else if(k === "text") node.textContent = v;
      else if(k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    (children||[]).forEach(c => node.appendChild(c));
    return node;
  };

  // ---------- Modal ----------
  function openModal(title, bodyNode, footButtons=[]) {
    $("#modalTitle").textContent = title;
    const body = $("#modalBody");
    const foot = $("#modalFoot");
    body.innerHTML = "";
    foot.innerHTML = "";
    body.appendChild(bodyNode);
    footButtons.forEach(btn => foot.appendChild(btn));
    $("#modal").classList.add("open");
    $("#modal").setAttribute("aria-hidden", "false");
  }
  function closeModal() {
    $("#modal").classList.remove("open");
    $("#modal").setAttribute("aria-hidden", "true");
  }

  // ---------- State ----------
  let state = load();

  // ---------- Firestore backup ----------
  let firestoreDb = null;
  let backupTimer = null;
  let pendingBackup = false;
  let backupStatus = "offline";

  function getDeviceId() {
    const key = "focus_compass_device_id";
    let id = localStorage.getItem(key);
    if(!id) {
      id = uid();
      localStorage.setItem(key, id);
    }
    return id;
  }

  function initFirestore() {
    if(!window.firebase || !FIREBASE_CONFIG || !FIREBASE_CONFIG.projectId) return;
    try {
      if(!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      if(firebase.appCheck && FIREBASE_APPCHECK_SITE_KEY) {
        try {
          firebase.appCheck().activate(FIREBASE_APPCHECK_SITE_KEY, true);
        } catch {}
      }
      firestoreDb = firebase.firestore();
      setBackupStatus("online");
    } catch {
      firestoreDb = null;
      setBackupStatus("blocked");
    }
  }

  function setBackupStatus(status) {
    backupStatus = status;
    const el = document.getElementById("backupStatus");
    if(!el) return;
    el.classList.remove("online", "blocked", "syncing");
    if(status === "online") {
      el.textContent = "Backup: Online";
      el.classList.add("online");
    } else if(status === "syncing") {
      el.textContent = "Backup: Syncing";
      el.classList.add("syncing");
    } else if(status === "blocked") {
      el.textContent = "Backup: Blocked";
      el.classList.add("blocked");
    } else {
      el.textContent = "Backup: Offline";
    }
  }

  function scheduleBackup() {
    pendingBackup = true;
    if(!firestoreDb) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(runBackup, BACKUP_DEBOUNCE_MS);
    setBackupStatus(navigator.onLine ? "syncing" : "offline");
  }

  async function runBackup() {
    if(!firestoreDb) return;
    if(!navigator.onLine) return;
    try {
      const deviceId = getDeviceId();
      const payload = {
        state,
        updatedAt: now(),
        version: VERSION
      };
      await firestoreDb.collection("backups").doc(deviceId).set(payload);
      pendingBackup = false;
      setBackupStatus("online");
    } catch {
      pendingBackup = true;
      setBackupStatus("blocked");
    }
  }

  // ---------- Timer (simple, local) ----------
  const timer = {
    running: false,
    totalSec: 0,
    remainingSec: 0,
    startedAt: null,
    interval: null,
    label: "ready"
  };

  function setTimer(minutes) {
    const m = clamp(parseInt(minutes,10) || state.settings.defaultTimerMin, 1, 180);
    timer.totalSec = m*60;
    timer.remainingSec = timer.totalSec;
    timer.running = false;
    timer.startedAt = null;
    timer.label = "ready";
    clearInterval(timer.interval);
    timer.interval = null;
    renderTimer();
  }

  function startTimer() {
    if(timer.running) return;
    if(timer.remainingSec <= 0) setTimer(state.settings.defaultTimerMin);
    timer.running = true;
    timer.startedAt = Date.now();
    timer.label = "focus";
    timer.interval = setInterval(tick, 250);
    renderTimer();
  }

  function stopTimer() {
    timer.running = false;
    timer.startedAt = null;
    clearInterval(timer.interval);
    timer.interval = null;
    timer.label = "paused";
    renderTimer();
  }

  function clearTimer() {
    setTimer(state.settings.defaultTimerMin);
    timer.label = "ready";
    renderTimer();
  }

  function tick() {
    if(!timer.running) return;
    timer.remainingSec = Math.max(0, timer.remainingSec - 0.25);
    if(timer.remainingSec <= 0) {
      timer.running = false;
      clearInterval(timer.interval);
      timer.interval = null;
      timer.label = "done";
      // gentle nudge
      if(state.settings.nudges) {
        toast("Timer done. Take a breath, then choose the next good step.");
      }
    }
    renderTimer();
  }

  function fmtTime(sec) {
    sec = Math.round(sec);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return String(m).padStart(2,"0") + ":" + String(s).padStart(2,"0");
  }

  function renderTimer() {
    $("#timerTime").textContent = fmtTime(timer.remainingSec);
    $("#timerMeta").textContent = timer.label;
    $("#pillNow").textContent = timer.running ? "Timer running" : (timer.label === "done" ? "Timer finished" : "No timer running");
  }

  // ---------- Toast (simple status line) ----------
  let toastTimer = null;
  function toast(msg) {
    const el = $("#captureStatus");
    el.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.textContent = ""; }, 4200);
  }

  // ---------- App behaviors ----------
  function addTask(text, opts={}) {
    const t = {
      id: uid(),
      text: safeText(text),
      status: "open",
      createdAt: now(),
      pinned: !!opts.pinned,
      due: opts.due || null,
      projectId: opts.projectId || null,
      tags: normalizeTags(opts.tags || [])
    };
    if(!t.text) return null;
    state.tasks.unshift(t);
    save();
    return t;
  }

  function getTask(id) { return state.tasks.find(t => t.id === id) || null; }

  function setNextStep(taskId) {
    state.nextStepTaskId = taskId;
    save();
    renderNextStep();
    renderToday();
  }

  function toggleDone(taskId) {
    const t = getTask(taskId);
    if(!t) return;
    t.status = (t.status === "done") ? "open" : "done";
    t.doneAt = (t.status === "done") ? now() : null;

    // if a priority is done, keep it but visually done; user can archive done later
    if(state.nextStepTaskId === taskId && t.status === "done") {
      state.nextStepTaskId = null;
      timer.label = "ready";
      renderNextStep();
      renderTimer();
    }
    save();
    renderAll();
  }

  function removeTask(taskId) {
    state.tasks = state.tasks.filter(t => t.id !== taskId);
    state.priorities = state.priorities.filter(id => id !== taskId);
    if(state.nextStepTaskId === taskId) state.nextStepTaskId = null;
    save();
    renderAll();
  }

  function addPriority(taskId) {
    const limit = clamp(state.settings.wipLimit, 1, 10);
    const currentActive = state.priorities
      .map(id => getTask(id))
      .filter(t => t && t.status !== "done").length;

    if(currentActive >= limit) {
      toast(`WIP limit reached (${limit}). Finish or swap a priority.`);
      return;
    }
    if(!state.priorities.includes(taskId)) state.priorities.unshift(taskId);
    save();
    renderToday();
  }

  function removePriority(taskId) {
    state.priorities = state.priorities.filter(id => id !== taskId);
    save();
    renderToday();
  }

  function archiveDone() {
    // Soft-delete: move done tasks older than today out of the active list by removing them.
    // (You can export data if you want a permanent archive.)
    const today = new Date();
    today.setHours(0,0,0,0);
    const cutoff = today.getTime();

    const keep = [];
    for(const t of state.tasks) {
      if(t.status !== "done") { keep.push(t); continue; }
      if(!t.doneAt) { keep.push(t); continue; }
      const doneTime = new Date(t.doneAt).getTime();
      // keep done tasks completed today (nice to see them for a bit)
      if(doneTime >= cutoff) keep.push(t);
    }
    state.tasks = keep;
    // also clean priorities that no longer exist
    const ids = new Set(state.tasks.map(t => t.id));
    state.priorities = state.priorities.filter(id => ids.has(id));
    save();
    renderAll();
    toast("Archived older done items.");
  }

  function autopickNext() {
    // choose next open priority, else first open inbox task
    const p = state.priorities.map(id => getTask(id)).filter(t => t && t.status === "open");
    const next = p[0] || state.tasks.find(t => t.status === "open");
    if(next) {
      setNextStep(next.id);
      toast("Next step set. Start a 10–25 minute timer.");
    } else {
      toast("Nothing open right now. Add one small task.");
    }
  }

  // ---------- Micro-tools ----------
  const tools = {
    twoMin: {
      title: "2-minute rule",
      body: () => el("div", {}, [
        el("p", { class:"muted" , text:"If it takes ~2 minutes or less, do it now. Then stop. This is about momentum, not perfection." }),
        el("p", { class:"small muted", text:"Examples: reply to one email, put one thing away, start a load of laundry, create a calendar invite." })
      ])
    },
    tenMin: {
      title: "10-minute starter",
      body: () => el("div", {}, [
        el("p", { class:"muted", text:"Set a 10-minute timer and only aim to start. When it ends, you can stop without guilt." }),
        el("p", { class:"small muted", text:"Starting is often the hardest executive-function step; a starter timer is a workaround." })
      ]),
      action: () => { setTimer(10); startTimer(); }
    },
    shrink: {
      title: "Shrink the task",
      body: () => {
        const wrap = el("div");
        wrap.appendChild(el("p", { class:"muted", text:"Turn the task into something smaller, concrete, and startable." }));
        const list = el("ul");
        ["Open the document only",
         "Write 2 bullets, not the whole thing",
         "Find the file, don’t fix the whole system",
         "Set up the first 5 minutes, then stop",
         "Ask: “What is the *first physical action*?”"
        ].forEach(x => list.appendChild(el("li", { class:"small muted", text:x })));
        wrap.appendChild(list);
        return wrap;
      }
    },
    bodyDouble: {
      title: "Body double script",
      body: () => el("div", {}, [
        el("p", { class:"muted", text:"Message a friend/colleague: “Can we co-work for 20 minutes? No talking needed. I’ll work on X.”" }),
        el("p", { class:"small muted", text:"Body-doubling works by adding mild social structure and external accountability." })
      ])
    }
  };

  function showTool(key) {
    const t = tools[key];
    const box = $("#toolbox");
    box.innerHTML = "";
    box.classList.add("compact");

    const head = el("div", { class:"tool-head" });
    head.appendChild(el("div", { class:"item-title", text: t.title }));
    const infoBtn = el("button", { class:"tool-info", text:"i" });
    head.appendChild(infoBtn);
    box.appendChild(head);

    const details = el("div", { class:"tool-details" });
    details.appendChild(t.body());
    if(t.action) {
      const b = el("button", { class:"btn btn-ghost", text:"Do it now", onclick: t.action });
      details.appendChild(el("div", { class:"tool-action" }, [b]));
    }
    box.appendChild(details);

    infoBtn.addEventListener("click", () => {
      details.classList.toggle("open");
    });
  }

  // ---------- Projects ----------
  function addProject(name) {
    const p = { id: uid(), name: safeText(name), why:"", doneDef:"", createdAt: now(), archived:false, tags: [] };
    if(!p.name) return null;
    state.projects.unshift(p);
    save();
    return p;
  }
  function getProject(id){ return state.projects.find(p => p.id === id) || null; }
  function updateProject(id, patch){
    const p = getProject(id);
    if(!p) return;
    if(patch.tags) patch.tags = normalizeTags(patch.tags);
    Object.assign(p, patch);
    save();
  }

  function countLinkedOpenTasks(projectId) {
    return state.tasks.filter(t => t.projectId === projectId && t.status !== "done").length;
  }

  function convertTaskToProject(task) {
    if(!task || task.projectId) return;
    const name = safeText(task.text);
    const p = addProject(name);
    if(!p) return;
    task.projectId = p.id;
    if(task.tags && task.tags.length) p.tags = normalizeTags(task.tags);
    save();
    selectedProjectId = p.id;
    renderProjects();
    renderToday();
    showView("projects");
    toast("Converted to a project. Add why and a definition of done.");
  }

  let selectedProjectId = null;

  // ---------- Chunking helpers ----------
  const PHYSICAL_KEYWORDS = [
    "clean","desk","declutter","organize","tidy","mess","clutter","drawer","closet",
    "garage","room","office","surface","paper","files","stack","pile"
  ];

  function isPhysicalProject(name) {
    const n = safeText(name).toLowerCase();
    return PHYSICAL_KEYWORDS.some(k => n.includes(k));
  }

  function normalizeSteps(steps) {
    const seen = new Set();
    const cleaned = [];
    steps.forEach(step => {
      const text = safeText(step);
      if(!text) return;
      const key = text.toLowerCase();
      if(seen.has(key)) return;
      seen.add(key);
      cleaned.push(text);
    });

    const fallback = [
      "Open the document or workspace",
      "Write 2 bullets of what “done” means",
      "Identify the first physical action",
      "Set up your environment for 10 minutes"
    ];

    let i = 0;
    while(cleaned.length < 3 && i < fallback.length) {
      cleaned.push(fallback[i]);
      i += 1;
    }

    return cleaned.slice(0, 8);
  }

  function generatePhysicalSteps(projectName, areas) {
    const area = areas[0] || "one small surface";
    const steps = [
      "Set a 10-minute timer",
      `Clear ${area} only (stop there)`,
      "Throw away obvious trash",
      "Put loose papers into one stack",
      "Create 3 bins: Keep / Relocate / Trash",
      "Move “Relocate” items into one bin or bag",
      `Wipe ${area} if you have time`
    ];

    if(areas.length > 1) {
      steps.splice(3, 0, `Pick the next area later: ${areas[1]}`);
    }

    if(!isPhysicalProject(projectName)) {
      steps.splice(1, 0, "Decide the smallest area to start with");
    }

    return normalizeSteps(steps);
  }

  function generateTimeSteps(projectName, timebox) {
    const t = clamp(parseInt(timebox,10) || 10, 5, 60);
    const physical = isPhysicalProject(projectName);
    const firstAction = physical
      ? "Pick one small area and touch it first"
      : "Open the document/folder and name the first section";

    const steps = [
      `Set a ${t}-minute timer`,
      firstAction,
      `Work for ${t} minutes, then stop`,
      "Write down the next tiny step before you stop",
      "Do a 30-second reset (put one thing away)"
    ];

    return normalizeSteps(steps);
  }

  function generateEnergySteps(projectName, energy) {
    const level = (energy || "Low").toLowerCase();
    const physical = isPhysicalProject(projectName);
    let steps = [];

    if(level === "low") {
      steps = [
        "Set a 5–10 minute timer",
        "Remove obvious trash or recycling",
        "Clear just one small surface",
        "Put everything else into one “sort later” pile",
        "Stop and breathe; you did enough"
      ];
    } else if(level === "high") {
      steps = [
        "Set a 25-minute timer",
        "Create Keep / Relocate / Trash bins",
        "Sort one full category or drawer",
        "Label or group the keep items",
        "Note the next system improvement"
      ];
    } else {
      steps = [
        "Set a 10–15 minute timer",
        "Clear one surface or section",
        "Group similar items into small piles",
        "Relocate items that belong elsewhere",
        "Write the next tiny step"
      ];
    }

    if(!physical) {
      steps.splice(2, 0, "Open the file or workspace and make the first change");
    }

    return normalizeSteps(steps);
  }

  function generateChunkSteps(projectName, mode, options) {
    if(mode === "time") return generateTimeSteps(projectName, options.timebox);
    if(mode === "energy") return generateEnergySteps(projectName, options.energy);
    return generatePhysicalSteps(projectName, options.areas || []);
  }

  function openChunkingModal(project) {
    let mode = "physical";
    let timebox = 10;
    let energy = "Low";
    const selectedAreas = new Set(["Desktop surface only"]);

    const body = el("div");
    body.appendChild(el("p", { class:"muted", text:"Pick a chunking mode. We’ll generate small, linked steps you can edit." }));

    const modeRow = el("div", { class:"chunk-modes" });

    const modeButtons = [
      { key:"physical", label:"Physical-space chunking" },
      { key:"time", label:"Time-based chunking" },
      { key:"energy", label:"Energy-based chunking" }
    ].map(m => {
      const btn = el("button", { class:"chunk-mode" + (m.key === mode ? " active" : ""), text:m.label });
      btn.addEventListener("click", () => {
        mode = m.key;
        modeButtons.forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
        Object.entries(sections).forEach(([k, node]) => node.classList.toggle("active", k === mode));
      });
      btn.dataset.mode = m.key;
      modeRow.appendChild(btn);
      return btn;
    });

    body.appendChild(modeRow);

    const sections = {};

    // Physical section
    const physical = el("div", { class:"chunk-section active" });
    physical.appendChild(el("div", { class:"label", text:"Choose an area to start" }));
    const areaOptions = [
      "Desktop surface only",
      "Under the desk",
      "One drawer",
      "One pile"
    ];
    const optionRow = el("div", { class:"chunk-options" });
    const optionButtons = areaOptions.map(label => {
      const btn = el("button", { class:"chunk-option" + (selectedAreas.has(label) ? " active" : ""), text:label });
      btn.addEventListener("click", () => {
        if(selectedAreas.has(label)) selectedAreas.delete(label);
        else selectedAreas.add(label);
        btn.classList.toggle("active", selectedAreas.has(label));
      });
      optionRow.appendChild(btn);
      return btn;
    });
    physical.appendChild(optionRow);

    const otherWrap = el("div", { style:"margin-top:10px;" });
    otherWrap.appendChild(el("div", { class:"label", text:"Other (optional)" }));
    const otherInput = el("input", { class:"input", placeholder:"e.g., top shelf, bag of papers" });
    otherWrap.appendChild(otherInput);
    physical.appendChild(otherWrap);
    physical.appendChild(el("div", { class:"chunk-hint", text:"Tip: pick just one area to start. Finishing later still counts." }));

    // Time section
    const time = el("div", { class:"chunk-section" });
    time.appendChild(el("div", { class:"label", text:"Pick a timebox" }));
    const timeRow = el("div", { class:"chunk-options" });
    [5,10,25].forEach(min => {
      const btn = el("button", { class:"chunk-option" + (timebox === min ? " active" : ""), text:`${min}m` });
      btn.addEventListener("click", () => {
        timebox = min;
        timeRow.querySelectorAll(".chunk-option").forEach(x => x.classList.remove("active"));
        btn.classList.add("active");
      });
      timeRow.appendChild(btn);
    });
    time.appendChild(timeRow);
    time.appendChild(el("div", { class:"chunk-hint", text:"Time-based steps focus on starting and stopping on purpose." }));

    // Energy section
    const energyBox = el("div", { class:"chunk-section" });
    energyBox.appendChild(el("div", { class:"label", text:"What energy do you have today?" }));
    const energyRow = el("div", { class:"chunk-options" });
    ["Low","Medium","High"].forEach(level => {
      const btn = el("button", { class:"chunk-option" + (energy === level ? " active" : ""), text:level });
      btn.addEventListener("click", () => {
        energy = level;
        energyRow.querySelectorAll(".chunk-option").forEach(x => x.classList.remove("active"));
        btn.classList.add("active");
      });
      energyRow.appendChild(btn);
    });
    energyBox.appendChild(energyRow);
    energyBox.appendChild(el("div", { class:"chunk-hint", text:"Low energy = tiny steps. High energy = deeper sorting." }));

    sections.physical = physical;
    sections.time = time;
    sections.energy = energyBox;

    body.appendChild(physical);
    body.appendChild(time);
    body.appendChild(energyBox);

    const cancelBtn = el("button", { class:"btn btn-ghost", text:"Cancel", onclick: closeModal });
    const createBtn = el("button", { class:"btn", text:"Create steps", onclick: () => {
      const areas = Array.from(selectedAreas).filter(Boolean);
      const other = safeText(otherInput.value);
      if(other) areas.unshift(other);
      if(areas.length === 0) areas.push("Desktop surface only");

      const steps = generateChunkSteps(project.name, mode, { areas, timebox, energy });

      for(let i = steps.length - 1; i >= 0; i -= 1) {
        addTask(steps[i], { projectId: project.id });
      }

      closeModal();
      renderProjects();
      renderToday();
      toast(`Created ${steps.length} linked steps.`);
    }});

    openModal("Break this project into steps", body, [cancelBtn, createBtn]);
  }

  const ROUTINE_TEMPLATES = [
    {
      id: "physical-health",
      name: "Physical health (basic)",
      meta: "Low-effort care",
      steps: [
        "Drink a glass of water",
        "Eat something with protein",
        "Take meds or vitamins (if applicable)",
        "Move your body for 5 minutes",
        "Do a 2-minute stretch"
      ]
    },
    {
      id: "mental-health",
      name: "Mental health reset",
      meta: "Calm the nervous system",
      steps: [
        "Take 3 slow breaths",
        "Name one feeling (no fixing)",
        "Write one worry on paper",
        "Do one tiny calming action (tea, music, light)",
        "Note one small win"
      ]
    },
    {
      id: "social-connection",
      name: "Social connection",
      meta: "Light touchpoints",
      steps: [
        "Send one check-in text",
        "Respond to one message",
        "Thank someone for something small",
        "Schedule a 10-minute call (optional)"
      ]
    },
    {
      id: "focus",
      name: "Focus starter",
      meta: "Get into motion",
      steps: [
        "Clear one small surface",
        "Pick the Next Step",
        "Set a 10-minute timer",
        "Work until the timer ends",
        "Write the next tiny step"
      ]
    },
    {
      id: "energy",
      name: "Energy boost",
      meta: "Gentle activation",
      steps: [
        "Get light in your eyes for 2 minutes",
        "Drink water",
        "Move your body for 2 minutes",
        "Eat a small snack",
        "Do a 3-minute tidy"
      ]
    }
  ];

  // ---------- Routines ----------
  function addRoutine(name) {
    const r = { id: uid(), name: safeText(name), steps: ["Step 1"], createdAt: now() };
    if(!r.name) return null;
    state.routines.unshift(r);
    save();
    return r;
  }
  function getRoutine(id){ return state.routines.find(r => r.id === id) || null; }
  function updateRoutine(id, patch){
    const r = getRoutine(id);
    if(!r) return;
    Object.assign(r, patch);
    save();
  }

  function createRoutineFromTemplate(template) {
    if(!template) return;
    const r = addRoutine(template.name);
    if(!r) return;
    updateRoutine(r.id, { steps: (template.steps || []).map(safeText).filter(Boolean) });
    selectedRoutineId = r.id;
    renderRoutines();
    toast("Template added. Edit to personalize.");
    editRoutine(r.id);
  }

  let selectedRoutineId = null;

  // ---------- Wins / Interruptions ----------
  function addWin(text) {
    const w = { id: uid(), text: safeText(text), createdAt: now() };
    if(!w.text) return null;
    state.wins.unshift(w);
    save();
    return w;
  }
  function addInterruption(text) {
    const it = { id: uid(), text: safeText(text), createdAt: now(), resolved:false };
    if(!it.text) return null;
    state.interruptions.unshift(it);
    save();
    return it;
  }
  function resolveInterruption(id){
    const it = state.interruptions.find(x => x.id === id);
    if(!it) return;
    it.resolved = true;
    save();
    renderReview();
  }

  // ---------- Tags ----------
  function getAllTags() {
    state.tags = normalizeTags(state.tags || []);
    return state.tags;
  }

  function getTagColor(tag) {
    const clean = normalizeTag(tag);
    if(!clean) return "#e5e7eb";
    if(!state.tagColors) state.tagColors = {};
    if(!state.tagColors[clean]) {
      const idx = hashTag(clean) % TAG_PALETTE.length;
      state.tagColors[clean] = TAG_PALETTE[idx];
      save();
    }
    return state.tagColors[clean];
  }

  function addTag(tag) {
    const clean = normalizeTag(tag);
    if(!clean) return;
    const tags = getAllTags();
    if(tags.some(t => t.toLowerCase() === clean.toLowerCase())) return;
    tags.push(clean);
    state.tags = tags;
    getTagColor(clean);
    save();
  }

  function renameTag(oldTag, newTag) {
    const oldClean = normalizeTag(oldTag);
    const newClean = normalizeTag(newTag);
    if(!oldClean || !newClean) return;
    const tags = getAllTags();
    if(!tags.some(t => t.toLowerCase() === oldClean.toLowerCase())) return;
    if(tags.some(t => t.toLowerCase() === newClean.toLowerCase())) return;
    state.tags = tags.map(t => (t.toLowerCase() === oldClean.toLowerCase() ? newClean : t));
    if(state.tagColors && state.tagColors[oldClean]) {
      state.tagColors[newClean] = state.tagColors[oldClean];
      delete state.tagColors[oldClean];
    }
    state.tasks.forEach(t => {
      t.tags = normalizeTags((t.tags || []).map(x => (x.toLowerCase() === oldClean.toLowerCase() ? newClean : x)));
    });
    state.projects.forEach(p => {
      p.tags = normalizeTags((p.tags || []).map(x => (x.toLowerCase() === oldClean.toLowerCase() ? newClean : x)));
    });
    save();
  }

  function deleteTag(tag) {
    const clean = normalizeTag(tag);
    if(!clean) return;
    state.tags = getAllTags().filter(t => t.toLowerCase() !== clean.toLowerCase());
    if(state.tagColors) delete state.tagColors[clean];
    state.tasks.forEach(t => {
      t.tags = normalizeTags((t.tags || []).filter(x => x.toLowerCase() !== clean.toLowerCase()));
    });
    state.projects.forEach(p => {
      p.tags = normalizeTags((p.tags || []).filter(x => x.toLowerCase() !== clean.toLowerCase()));
    });
    save();
  }

  function openTagPicker({ title, selected, onSave }) {
    const tags = getAllTags();
    const picked = new Set((selected || []).map(t => t.toLowerCase()));
    const wrap = el("div");
    wrap.appendChild(el("div", { class:"muted small", text:"Select tags. You can manage tags in Settings." }));
    const list = el("div", { class:"list", style:"margin-top:10px;" });
    if(tags.length === 0) {
      list.appendChild(el("div", { class:"muted", text:"No tags yet." }));
    } else {
      tags.forEach(tag => {
        const row = el("div", { class:"item", style:"justify-content:space-between; align-items:center;" });
        row.appendChild(el("div", { class:"item-title", text: tag }));
        const check = el("input", { type:"checkbox" });
        check.checked = picked.has(tag.toLowerCase());
        check.addEventListener("change", () => {
          if(check.checked) picked.add(tag.toLowerCase());
          else picked.delete(tag.toLowerCase());
        });
        row.appendChild(check);
        list.appendChild(row);
      });
    }
    wrap.appendChild(list);
    const saveBtn = el("button", { class:"btn", text:"Save", onclick: () => {
      const next = tags.filter(t => picked.has(t.toLowerCase()));
      onSave(normalizeTags(next));
      closeModal();
    }});
    const cancelBtn = el("button", { class:"btn btn-ghost", text:"Cancel", onclick: closeModal });
    openModal(title, wrap, [cancelBtn, saveBtn]);
  }
  function removeInterruption(id){
    state.interruptions = state.interruptions.filter(x => x.id !== id);
    save();
    renderReview();
  }

  // ---------- Rendering ----------
  function renderNextStep() {
    const wrap = $("#nextStepCard");
    wrap.innerHTML = "";
    const t = state.nextStepTaskId ? getTask(state.nextStepTaskId) : null;

    if(!t || t.status === "done") {
      wrap.appendChild(el("div", { class:"muted", text:"Pick a task → Set as Next Step." }));
      $("#nowNextStep").textContent = "—";
      $("#nowContext").textContent = "Choose a task → “Set as Next Step”.";
      return;
    }

    const title = el("div", { class:"item-title", text: t.text });
    const meta = el("div", { class:"item-meta", text: t.projectId ? "Project-linked" : "Captured task" });

    const row = el("div", { class:"item-actions" }, [
      el("button", { class:"iconbtn", text:"Start 10m", onclick: () => { setTimer(10); startTimer(); }}),
      el("button", { class:"iconbtn", text:"Start 25m", onclick: () => { setTimer(25); startTimer(); }}),
      el("button", { class:"iconbtn", text:"Done", onclick: () => toggleDone(t.id) })
    ]);

    wrap.appendChild(title);
    wrap.appendChild(meta);
    wrap.appendChild(el("div", { style:"margin-top:10px;" }, [row]));

    $("#nowNextStep").textContent = t.text;
    $("#nowContext").textContent = "Aim for progress, not completion.";
  }

  function renderTaskItem(t, { asPriority=false } = {}) {
    const left = el("div", { class:"item-left" });

    const check = el("div", { class: "check" + (t.status === "done" ? " done" : "") });
    check.appendChild(el("span", { text: t.status === "done" ? "✓" : "" }));
    check.addEventListener("click", () => toggleDone(t.id));

    const body = el("div", { style:"flex:1;" });
    body.appendChild(el("div", { class:"item-title", text: t.text }));
    const metas = [];
    if(t.due) metas.push("Due " + fmtDate(t.due));
    if(t.projectId) {
      const p = getProject(t.projectId);
      if(p) metas.push("Project: " + p.name);
    }
    metas.push(t.status === "done" ? "Done" : "Open");
    body.appendChild(el("div", { class:"item-meta", text: metas.join(" • ") }));
    const tagRow = renderTagRow(t.tags || []);
    if(tagRow) body.appendChild(tagRow);

    left.appendChild(check);
    left.appendChild(body);

    const actions = el("div", { class:"item-actions" });
    actions.appendChild(el("button", { class:"iconbtn", text:"Make next step", onclick: () => setNextStep(t.id) }));
    actions.appendChild(el("button", { class:"iconbtn", text:"10m", onclick: () => { setNextStep(t.id); setTimer(10); startTimer(); } }));
    if(asPriority) {
      actions.appendChild(el("button", { class:"iconbtn", text:"Remove priority", onclick: () => removePriority(t.id) }));
    } else {
      actions.appendChild(el("button", { class:"iconbtn", text:"Add to priorities", onclick: () => addPriority(t.id) }));
    }
    actions.appendChild(el("button", { class:"iconbtn", text:"Tags", onclick: () => {
      openTagPicker({
        title: "Task tags",
        selected: t.tags || [],
        onSave: (tags) => {
          t.tags = tags;
          save();
          renderAll();
        }
      });
    }}));
    if(!t.projectId) {
      actions.appendChild(el("button", { class:"iconbtn", text:"Convert to project", onclick: () => convertTaskToProject(t) }));
    }
    actions.appendChild(el("button", { class:"iconbtn", text:"Delete", onclick: () => removeTask(t.id) }));

    return el("div", { class:"item" }, [left, actions]);
  }

  function renderToday() {
    $("#wipLimitText").textContent = String(state.settings.wipLimit);

    const priorityList = $("#priorityList");
    const inboxList = $("#inboxList");
    renderTagFilters("#tagFiltersToday");
    priorityList.innerHTML = "";
    inboxList.innerHTML = "";

    const activeTag = state.activeTagFilter || "all";
    const tagMatch = (t) => {
      if(activeTag === "all") return true;
      return (t.tags || []).some(tag => tag.toLowerCase() === activeTag.toLowerCase());
    };

    // Priorities in order
    const priorityTasks = state.priorities
      .map(id => getTask(id))
      .filter(Boolean)
      .filter(tagMatch);

    if(priorityTasks.length === 0) {
      priorityList.appendChild(el("div", { class:"muted", text:"No priorities yet. Add up to your WIP limit." }));
    } else {
      priorityTasks.forEach(t => priorityList.appendChild(renderTaskItem(t, { asPriority:true })));
    }

    // Inbox = open tasks not in priorities + done tasks (so you can see wins) + anything captured
    const prioritySet = new Set(state.priorities);
    const inbox = state.tasks.filter(t => !prioritySet.has(t.id)).filter(tagMatch);

    if(inbox.length === 0) {
      inboxList.appendChild(el("div", { class:"muted", text:"Your capture inbox is empty. Nice." }));
    } else {
      inbox.forEach(t => inboxList.appendChild(renderTaskItem(t, { asPriority:false })));
    }

    renderNextStep();
    renderTimer();
  }

  function renderProjects() {
    const list = $("#projectList");
    list.innerHTML = "";
    renderTagFilters("#tagFiltersProjects");

    const activeTag = state.activeTagFilter || "all";
    const projectMatch = (p) => {
      if(activeTag === "all") return true;
      return (p.tags || []).some(tag => tag.toLowerCase() === activeTag.toLowerCase());
    };

    const active = state.projects.filter(p => !p.archived).filter(projectMatch);
    if(active.length === 0) {
      list.appendChild(el("div", { class:"muted", text:"No projects yet. Create one for anything that’s more than one step." }));
    } else {
      active.forEach(p => {
        const row = el("div", { class:"item" });
        const left = el("div", { class:"item-left" });
        left.appendChild(el("div", { class:"item-title", text: p.name }));
        const metaBits = [];
        const openCount = countLinkedOpenTasks(p.id);
        metaBits.push(`${openCount} open ${openCount === 1 ? "task" : "tasks"}`);
        if(p.why) metaBits.push("why set");
        if(p.doneDef) metaBits.push("done defined");
        left.appendChild(el("div", { class:"item-meta", text: metaBits.length ? metaBits.join(" • ") : "needs definition" }));
        const tagRow = renderTagRow(p.tags || []);
        if(tagRow) left.appendChild(tagRow);
        row.appendChild(left);

        const actions = el("div", { class:"item-actions" });
        actions.appendChild(el("button", { class:"iconbtn", text:"Open", onclick: () => { selectedProjectId = p.id; renderProjectDetails(); } }));
        row.appendChild(actions);
        list.appendChild(row);
      });
    }

    renderProjectDetails();
  }

  function renderProjectDetails() {
    const box = $("#projectDetails");
    box.innerHTML = "";
    const p = selectedProjectId ? getProject(selectedProjectId) : null;
    if(!p) {
      box.appendChild(el("div", { class:"muted", text:"Select a project to view/edit." }));
      return;
    }

    const name = el("input", { class:"input", value: p.name });
    const why = el("textarea", { class:"input", rows:"3" });
    why.value = p.why || "";
    const doneDef = el("textarea", { class:"input", rows:"3" });
    doneDef.value = p.doneDef || "";

    const saveBtn = el("button", { class:"btn", text:"Save" , onclick: () => {
      updateProject(p.id, { name: safeText(name.value), why: safeText(why.value), doneDef: safeText(doneDef.value) });
      renderProjects();
      toast("Project saved.");
    }});

    const addTaskBtn = el("button", { class:"btn btn-ghost", text:"Create one next action", onclick: () => {
      const t = addTask("Next action: " + p.name, { projectId: p.id });
      if(t) {
        addPriority(t.id);
        setNextStep(t.id);
        toast("Next action created and added as a priority.");
      }
    }});

    const chunkBtn = el("button", { class:"btn btn-ghost", text:"Break this into steps", onclick: () => openChunkingModal(p) });
    const tagBtn = el("button", { class:"btn btn-ghost", text:"Edit tags", onclick: () => {
      openTagPicker({
        title: "Project tags",
        selected: p.tags || [],
        onSave: (tags) => {
          updateProject(p.id, { tags });
          renderProjects();
        }
      });
    }});

    const archiveBtn = el("button", { class:"btn btn-ghost", text:"Archive project", onclick: () => {
      updateProject(p.id, { archived:true });
      selectedProjectId = null;
      renderProjects();
      toast("Project archived.");
    }});

    box.appendChild(el("div", { class:"label", text:"Project name" }));
    box.appendChild(name);
    box.appendChild(el("div", { class:"label", style:"margin-top:10px;", text:"Why this matters (1–2 lines)" }));
    box.appendChild(why);
    box.appendChild(el("div", { class:"label", style:"margin-top:10px;", text:"Definition of done (what counts as finished?)" }));
    box.appendChild(doneDef);
    box.appendChild(el("div", { style:"margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;" }, [saveBtn, addTaskBtn, chunkBtn, tagBtn, archiveBtn]));
    box.appendChild(el("div", { class:"helper", text:"Next Step = the one task you’ll do next. It should be startable in under 10 minutes." }));

    // linked tasks
    const linked = state.tasks.filter(t => t.projectId === p.id);
    box.appendChild(el("div", { class:"divider" }));
    box.appendChild(el("div", { class:"item-title", text:"Linked tasks" }));
    if(linked.length === 0) {
      box.appendChild(el("div", { class:"muted", text:"No linked tasks yet." }));
    } else {
      const wrap = el("div", { class:"list", style:"margin-top:10px;" });
      linked.forEach(t => wrap.appendChild(renderTaskItem(t, { asPriority: state.priorities.includes(t.id) })));
      box.appendChild(wrap);
    }
  }

  function renderRoutines() {
    renderRoutineTemplates();
    const list = $("#routineList");
    list.innerHTML = "";
    const rs = state.routines;

    if(rs.length === 0) {
      list.appendChild(el("div", { class:"muted", text:"No routines yet. Create a short morning or end-of-day checklist." }));
    } else {
      rs.forEach(r => {
        const row = el("div", { class:"item" });
        const left = el("div", { class:"item-left" });
        left.appendChild(el("div", { class:"item-title", text: r.name }));
        left.appendChild(el("div", { class:"item-meta", text: `${r.steps.length} steps` }));
        row.appendChild(left);

        const actions = el("div", { class:"item-actions" });
        actions.appendChild(el("button", { class:"iconbtn", text:"Run", onclick: () => { selectedRoutineId = r.id; renderRoutineRunner(); } }));
        actions.appendChild(el("button", { class:"iconbtn", text:"Edit", onclick: () => editRoutine(r.id) }));
        row.appendChild(actions);

        list.appendChild(row);
      });
    }
    renderRoutineRunner();
  }

  function renderRoutineTemplates() {
    const box = $("#routineTemplates");
    if(!box) return;
    box.innerHTML = "";
    ROUTINE_TEMPLATES.forEach(t => {
      const row = el("div", { class:"item" });
      const left = el("div", { class:"item-left" });
      left.appendChild(el("div", { class:"item-title", text: t.name }));
      left.appendChild(el("div", { class:"item-meta", text: `${t.meta} • ${t.steps.length} steps` }));
      row.appendChild(left);

      const actions = el("div", { class:"item-actions" });
      actions.appendChild(el("button", { class:"iconbtn", text:"Use template", onclick: () => createRoutineFromTemplate(t) }));
      row.appendChild(actions);

      box.appendChild(row);
    });
  }

  function renderRoutineRunner() {
    const box = $("#routineRunner");
    box.innerHTML = "";
    const r = selectedRoutineId ? getRoutine(selectedRoutineId) : null;
    if(!r) {
      box.appendChild(el("div", { class:"muted", text:"Select a routine to run it." }));
      return;
    }

    box.appendChild(el("div", { class:"item-title", text: r.name }));
    box.appendChild(el("div", { class:"muted small", text:"Check each step; keep it short; stop when done enough." }));

    const wrap = el("div", { class:"list", style:"margin-top:10px;" });
    const done = new Set();
    r.steps.forEach((step, idx) => {
      const item = el("div", { class:"item" });
      const left = el("div", { class:"item-left" });
      const check = el("div", { class:"check" });
      check.appendChild(el("span", { text:"" }));
      check.addEventListener("click", () => {
        const key = String(idx);
        if(done.has(key)) { done.delete(key); check.classList.remove("done"); check.firstChild.textContent=""; }
        else { done.add(key); check.classList.add("done"); check.firstChild.textContent="✓"; }
      });
      const body = el("div", { style:"flex:1;" });
      body.appendChild(el("div", { class:"item-title", text: step }));
      left.appendChild(check);
      left.appendChild(body);
      item.appendChild(left);
      wrap.appendChild(item);
    });
    box.appendChild(wrap);

    box.appendChild(el("div", { style:"margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;" }, [
      el("button", { class:"btn", text:"Log a win", onclick: () => {
        addWin(`Ran routine: ${r.name}`);
        renderReview();
        toast("Win logged.");
      }}),
      el("button", { class:"btn btn-ghost", text:"Edit routine", onclick: () => editRoutine(r.id) })
    ]));
  }

  function editRoutine(routineId) {
    const r = getRoutine(routineId);
    if(!r) return;

    const wrap = el("div");
    wrap.appendChild(el("div", { class:"label", text:"Routine name" }));
    const name = el("input", { class:"input", value: r.name });
    wrap.appendChild(name);

    wrap.appendChild(el("div", { class:"label", style:"margin-top:10px;", text:"Steps (one per line)" }));
    const steps = el("textarea", { class:"input", rows:"10" });
    steps.value = (r.steps || []).join("\n");
    wrap.appendChild(steps);

    const saveBtn = el("button", { class:"btn", text:"Save", onclick: () => {
      updateRoutine(r.id, { name: safeText(name.value), steps: steps.value.split(/\n+/).map(safeText).filter(Boolean) });
      closeModal();
      renderRoutines();
      toast("Routine saved.");
    }});
    const delBtn = el("button", { class:"btn btn-ghost", text:"Delete routine", onclick: () => {
      state.routines = state.routines.filter(x => x.id !== r.id);
      if(selectedRoutineId === r.id) selectedRoutineId = null;
      save();
      closeModal();
      renderRoutines();
      toast("Routine deleted.");
    }});

    openModal("Edit routine", wrap, [delBtn, saveBtn]);
  }

  function renderReview() {
    // wins
    const winsList = $("#winsList");
    winsList.innerHTML = "";
    if(state.wins.length === 0) {
      winsList.appendChild(el("div", { class:"muted", text:"No wins logged yet. Start small: “I started.”" }));
    } else {
      state.wins.slice(0, 20).forEach(w => {
        const item = el("div", { class:"item" });
        const left = el("div", { class:"item-left" });
        left.appendChild(el("div", { class:"item-title", text: w.text }));
        left.appendChild(el("div", { class:"item-meta", text: fmtDate(w.createdAt) }));
        item.appendChild(left);
        const actions = el("div", { class:"item-actions" });
        actions.appendChild(el("button", { class:"iconbtn", text:"Delete", onclick: () => {
          state.wins = state.wins.filter(x => x.id !== w.id);
          save();
          renderReview();
        }}));
        item.appendChild(actions);
        winsList.appendChild(item);
      });
    }

    // interruptions
    const interruptList = $("#interruptList");
    interruptList.innerHTML = "";
    const items = state.interruptions.slice(0, 30);
    if(items.length === 0) {
      interruptList.appendChild(el("div", { class:"muted", text:"Empty. If you tend to interrupt, use “Hold that thought” as a muscle." }));
    } else {
      items.forEach(it => {
        const item = el("div", { class:"item" });
        const left = el("div", { class:"item-left" });
        left.appendChild(el("div", { class:"item-title", text: it.text }));
        left.appendChild(el("div", { class:"item-meta", text: (it.resolved ? "Resolved • " : "Open • ") + fmtDate(it.createdAt) }));
        item.appendChild(left);

        const actions = el("div", { class:"item-actions" });
        if(!it.resolved) actions.appendChild(el("button", { class:"iconbtn", text:"Resolve", onclick: () => resolveInterruption(it.id) }));
        actions.appendChild(el("button", { class:"iconbtn", text:"Delete", onclick: () => removeInterruption(it.id) }));
        item.appendChild(actions);

        interruptList.appendChild(item);
      });
    }

    // stats
    const stats = $("#statsBox");
    stats.innerHTML = "";
    const openCount = state.tasks.filter(t => t.status === "open").length;
    const doneToday = (() => {
      const d = new Date(); d.setHours(0,0,0,0);
      const cutoff = d.getTime();
      return state.tasks.filter(t => t.status === "done" && t.doneAt && new Date(t.doneAt).getTime() >= cutoff).length;
    })();
    const activeProjects = state.projects.filter(p => !p.archived).length;
    const wip = state.priorities.map(id => getTask(id)).filter(t => t && t.status === "open").length;

    const lines = [
      ["Open tasks", String(openCount)],
      ["Done today", String(doneToday)],
      ["Active projects", String(activeProjects)],
      ["Open priorities", `${wip} / ${state.settings.wipLimit}`],
      ["Wins logged", String(state.wins.length)]
    ];

    lines.forEach(([k,v]) => {
      stats.appendChild(el("div", { class:"item", style:"justify-content:space-between; align-items:center;" }, [
        el("div", { class:"muted", text:k }),
        el("div", { class:"item-title", text:v })
      ]));
    });
  }

  function renderSettings() {
    $("#settingWip").value = state.settings.wipLimit;
    $("#settingTimer").value = state.settings.defaultTimerMin;
    $("#settingLowStim").checked = !!state.settings.lowStim;
    $("#settingNudges").checked = !!state.settings.nudges;
    $("#settingMinimal").checked = !!state.settings.minimalMode;
    applyLowStim();
    applyMinimalMode();
    applyToolsCollapsed();
  }

  function renderTagRow(tags) {
    const cleaned = normalizeTags(tags || []);
    if(cleaned.length === 0) return null;
    const row = el("div", { class:"tag-row" });
    cleaned.forEach(tag => {
      const chip = el("span", { class:"tag", text: tag });
      const color = getTagColor(tag);
      chip.style.borderColor = color;
      chip.style.color = color;
      row.appendChild(chip);
    });
    return row;
  }

  function renderTagFilters(containerId) {
    const box = $(containerId);
    if(!box) return;
    box.innerHTML = "";
    const tags = getAllTags();
    const active = state.activeTagFilter || "all";

    const allBtn = el("button", { class:"chip", text:"All" });
    allBtn.classList.toggle("active", active === "all");
    allBtn.addEventListener("click", () => {
      state.activeTagFilter = "all";
      save();
      renderAll();
    });
    box.appendChild(allBtn);

    tags.forEach(tag => {
      const btn = el("button", { class:"chip", text: tag });
      const color = getTagColor(tag);
      btn.style.borderColor = color;
      btn.style.color = color;
      btn.classList.toggle("active", active === tag);
      btn.addEventListener("click", () => {
        state.activeTagFilter = (active === tag ? "all" : tag);
        save();
        renderAll();
      });
      box.appendChild(btn);
    });
  }

  function renderTagManager() {
    const box = $("#tagManager");
    if(!box) return;
    box.innerHTML = "";
    const tags = getAllTags();
    if(tags.length === 0) {
      box.appendChild(el("div", { class:"muted", text:"No tags yet." }));
    } else {
      tags.forEach(tag => {
        const row = el("div", { class:"item", style:"justify-content:space-between; align-items:center;" });
        row.appendChild(el("div", { class:"item-title", text: tag }));
        const actions = el("div", { class:"item-actions" });
        actions.appendChild(el("button", { class:"iconbtn", text:"Rename", onclick: () => {
          const next = safeText(prompt("Rename tag:", tag));
          if(!next || next === tag) return;
          renameTag(tag, next);
          renderAll();
        }}));
        actions.appendChild(el("button", { class:"iconbtn", text:"Delete", onclick: () => {
          if(!confirm(`Delete tag “${tag}” from all tasks/projects?`)) return;
          deleteTag(tag);
          renderAll();
        }}));
        row.appendChild(actions);
        box.appendChild(row);
      });
    }
  }

  function applyLowStim() {
    document.body.classList.toggle("lowstim", !!state.settings.lowStim);
  }

  function applyMinimalMode() {
    document.body.classList.toggle("minimal", !!state.settings.minimalMode);
  }

  function applyToolsCollapsed() {
    const area = $("#toolsArea");
    const btn = $("#btnToggleTools");
    if(!area || !btn) return;
    const collapsed = !!state.settings.toolsCollapsed;
    area.classList.toggle("collapsed", collapsed);
    btn.textContent = collapsed ? "Show tools" : "Hide tools";
  }

  function renderAll() {
    renderToday();
    renderProjects();
    renderRoutines();
    renderReview();
    renderSettings();
    renderTagManager();
  }

  // ---------- Onboarding tooltips ----------
  const ONBOARDING_STEPS = [
    {
      id: "hold-thought",
      view: "today",
      target: "#btnHoldThought",
      title: "Hold that thought",
      body: "Use this to park interruptions so you can stay present. It builds the habit of not blurting or forgetting."
    },
    {
      id: "low-stim",
      view: "settings",
      target: "#settingLowStim",
      title: "Low-stim mode",
      body: "Reduces visual noise and motion so it’s easier to focus when your brain feels overstimulated."
    }
  ];

  const coachState = {
    active: false,
    index: 0,
    overlay: null,
    card: null,
    title: null,
    body: null,
    actions: null,
    targetEl: null
  };

  function ensureCoachElements() {
    if(coachState.overlay && coachState.card) return;
    const overlay = el("div", { class:"coach-overlay" });
    const card = el("div", { class:"coach-card", role:"dialog", "aria-live":"polite" });
    const title = el("div", { class:"coach-title" });
    const body = el("div", { class:"coach-body" });
    const actions = el("div", { class:"coach-actions" });

    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(actions);
    document.body.appendChild(overlay);
    document.body.appendChild(card);

    overlay.addEventListener("click", () => endOnboarding(true));

    coachState.overlay = overlay;
    coachState.card = card;
    coachState.title = title;
    coachState.body = body;
    coachState.actions = actions;
  }

  function clearCoachTarget() {
    if(coachState.targetEl) {
      coachState.targetEl.classList.remove("coach-target");
      coachState.targetEl = null;
    }
  }

  function positionCoachCard(target) {
    const card = coachState.card;
    if(!card || !target) return;
    const rect = target.getBoundingClientRect();
    const padding = 12;
    const cardRect = card.getBoundingClientRect();

    let top = rect.bottom + 12;
    if(top + cardRect.height > window.innerHeight - padding) {
      top = rect.top - cardRect.height - 12;
    }
    top = clamp(top, padding, window.innerHeight - cardRect.height - padding);

    let left = rect.left;
    left = clamp(left, padding, window.innerWidth - cardRect.width - padding);

    card.style.top = `${Math.round(top)}px`;
    card.style.left = `${Math.round(left)}px`;
  }

  function showCoachStep() {
    const step = ONBOARDING_STEPS[coachState.index];
    if(!step) { endOnboarding(true); return; }
    if(step.view) showView(step.view);
    const target = document.querySelector(step.target);
    if(!target) {
      coachState.index += 1;
      showCoachStep();
      return;
    }

    ensureCoachElements();
    clearCoachTarget();
    target.classList.add("coach-target");
    coachState.targetEl = target;

    coachState.title.textContent = step.title;
    coachState.body.textContent = step.body;
    coachState.actions.innerHTML = "";

    const skipBtn = el("button", { class:"btn btn-ghost", text:"Skip", onclick: () => endOnboarding(true) });
    const nextLabel = coachState.index === ONBOARDING_STEPS.length - 1 ? "Done" : "Next";
    const nextBtn = el("button", { class:"btn", text: nextLabel, onclick: () => { coachState.index += 1; showCoachStep(); } });
    coachState.actions.appendChild(skipBtn);
    coachState.actions.appendChild(nextBtn);

    positionCoachCard(target);
  }

  function startOnboarding(force=false) {
    if(state.onboarding.seen && !force) return;
    coachState.active = true;
    coachState.index = 0;
    if(!state.onboarding.seen) {
      state.onboarding.seen = true;
      save();
    }
    showCoachStep();
  }

  function endOnboarding(markSeen) {
    if(markSeen) {
      state.onboarding.seen = true;
      save();
    }
    coachState.active = false;
    clearCoachTarget();
    if(coachState.overlay) coachState.overlay.remove();
    if(coachState.card) coachState.card.remove();
    coachState.overlay = null;
    coachState.card = null;
    coachState.title = null;
    coachState.body = null;
    coachState.actions = null;
  }

  window.addEventListener("resize", () => {
    if(coachState.active && coachState.targetEl) positionCoachCard(coachState.targetEl);
  });

  // ---------- Navigation ----------
  function showView(viewKey) {
    $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === viewKey));
    $$(".view").forEach(v => v.classList.toggle("active", v.id === `view-${viewKey}`));
  }

  // ---------- Quick reset ----------
  function openReset() {
    const body = el("div");
    body.appendChild(el("p", { class:"muted", text:"Overwhelm is a nervous-system state, not a character flaw. Pick one reset:" }));
    const picks = [
      { title:"Name 3 next steps", text:"Write three tiny actions (each <5 min). Choose one." },
      { title:"Do a 10-minute starter", text:"Start with a 10-minute timer. Stop when it ends if you want." },
      { title:"Clear one surface", text:"Pick one small surface. Set a 5-minute timer. Done is done." },
      { title:"Ask for structure", text:"Message someone: “Can you check in with me in 30 minutes?”" },
      { title:"Choose to rest", text:"If you’re fried, rest on purpose for 10 minutes, then re-check." }
    ];
    const list = el("div", { class:"list", style:"margin-top:10px;" });
    picks.forEach(p => {
      const item = el("div", { class:"item" });
      const left = el("div", { class:"item-left" });
      left.appendChild(el("div", { class:"item-title", text: p.title }));
      left.appendChild(el("div", { class:"item-meta", text: p.text }));
      item.appendChild(left);
      item.addEventListener("click", () => {
        closeModal();
        toast(p.title);
        if(p.title.includes("10-minute")) { setTimer(10); startTimer(); }
      });
      list.appendChild(item);
    });
    body.appendChild(list);
    openModal("Reset", body, [el("button", { class:"btn btn-ghost", text:"Close", onclick: closeModal })]);
  }

  // ---------- Import / Export ----------
  function exportData() {
    const data = JSON.stringify(state, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href:url, download:`focus_compass_export_${new Date().toISOString().slice(0,10)}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Exported.");
  }

  function importDataFromFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || "{}"));
        // light validation
        if(!parsed || typeof parsed !== "object") throw new Error("Bad file");
        state = { ...defaultState(), ...parsed, settings: { ...defaultState().settings, ...(parsed.settings||{}) } };
        save();
        renderAll();
        toast("Imported.");
      } catch {
        toast("Import failed. Make sure it's a Focus Compass export JSON.");
      }
    };
    reader.readAsText(file);
  }

  // ---------- Event wiring ----------
  function init() {
    // nav
    $$(".nav-item").forEach(btn => btn.addEventListener("click", () => showView(btn.dataset.view)));

    // modal close
    $("#modal").addEventListener("click", (e) => {
      const t = e.target;
      if(t && t.dataset && t.dataset.close) closeModal();
    });

    // capture
    const commitQuick = () => {
      const text = safeText($("#quickInput").value);
      if(!text) return;
      const t = addTask(text);
      $("#quickInput").value = "";
      renderToday();
      toast("Captured.");
      // if nothing is a next step, suggest it
      if(!state.nextStepTaskId && t) setNextStep(t.id);
    };
    $("#quickAdd").addEventListener("click", commitQuick);
    $("#quickInput").addEventListener("keydown", (e) => {
      if(e.key === "Enter") { e.preventDefault(); commitQuick(); }
    });

    // hold thought (interruptions)
    $("#btnHoldThought").addEventListener("click", () => {
      const text = safeText(prompt("What do you want to remember or say later?"));
      if(!text) return;
      addInterruption(text);
      renderReview();
      toast("Saved to parking lot.");
    });

    // priorities
    $("#btnAddPriority").addEventListener("click", () => {
      const text = safeText(prompt("Add a priority (keep it concrete):"));
      if(!text) return;
      const t = addTask(text);
      if(t) addPriority(t.id);
      renderToday();
    });
    $("#btnAutopick").addEventListener("click", autopickNext);
    $("#btnClearDone").addEventListener("click", archiveDone);

    // timer buttons
    $$("[data-preset]").forEach(b => b.addEventListener("click", () => {
      const m = parseInt(b.dataset.preset,10);
      setTimer(m);
      renderTimer();
    }));
    $("#btnStartStop").addEventListener("click", () => {
      if(timer.running) stopTimer();
      else startTimer();
      $("#btnStartStop").textContent = timer.running ? "Stop" : "Start";
    });
    $("#btnClearTimer").addEventListener("click", () => {
      clearTimer();
      $("#btnStartStop").textContent = "Start";
    });
    $("#btnTimer").addEventListener("click", () => {
      const body = el("div");
      body.appendChild(el("p", { class:"muted", text:"Pick a timer length. Use it to start, not to punish yourself." }));
      const row = el("div", { style:"display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;" });
      [5,10,15,25,45,60].forEach(m => {
        row.appendChild(el("button", { class:"btn btn-ghost", text:`${m} minutes`, onclick: () => { setTimer(m); startTimer(); $("#btnStartStop").textContent="Stop"; closeModal(); } }));
      });
      body.appendChild(row);
      openModal("Timer", body, [el("button", { class:"btn btn-ghost", text:"Close", onclick: closeModal })]);
    });

    // microtools
    $$(".chip").forEach(b => b.addEventListener("click", () => showTool(b.dataset.tool)));
    $("#btnToggleTools").addEventListener("click", () => {
      state.settings.toolsCollapsed = !state.settings.toolsCollapsed;
      save();
      applyToolsCollapsed();
    });

    // projects
    $("#btnNewProject").addEventListener("click", () => {
      const name = safeText(prompt("Project name:"));
      if(!name) return;
      const p = addProject(name);
      selectedProjectId = p ? p.id : null;
      renderProjects();
      toast("Project created. Add a next action.");
    });

    // routines
    $("#btnNewRoutine").addEventListener("click", () => {
      const name = safeText(prompt("Routine name (e.g., “Morning at home”):"));
      if(!name) return;
      const r = addRoutine(name);
      selectedRoutineId = r ? r.id : null;
      renderRoutines();
      toast("Routine created.");
      editRoutine(selectedRoutineId);
    });

    // review
    $("#winAdd").addEventListener("click", () => {
      const t = safeText($("#winInput").value);
      if(!t) return;
      addWin(t);
      $("#winInput").value = "";
      renderReview();
    });
    $("#winInput").addEventListener("keydown", (e) => {
      if(e.key === "Enter") { e.preventDefault(); $("#winAdd").click(); }
    });
    $("#btnWeeklyReview").addEventListener("click", () => {
      const body = el("div");
      body.appendChild(el("p", { class:"muted", text:"A 5-minute weekly review. Keep it honest and kind." }));
      const qs = [
        "What worked (even a little)?",
        "What got in the way (no blame)?",
        "One thing to remove or simplify next week?",
        "One project to pause on purpose?",
        "What do I want to be true at home? at work?"
      ];
      const ul = el("ul");
      qs.forEach(q => ul.appendChild(el("li", { class:"small muted", text:q })));
      body.appendChild(ul);
      body.appendChild(el("p", { class:"small muted", text:"If shame shows up, treat it like weather: notice it; don’t obey it." }));
      openModal("Weekly review", body, [el("button", { class:"btn btn-ghost", text:"Close", onclick: closeModal })]);
    });

    // settings
    $("#btnSaveSettings").addEventListener("click", () => {
      const wip = clamp(parseInt($("#settingWip").value,10) || 3, 1, 10);
      const def = clamp(parseInt($("#settingTimer").value,10) || 25, 1, 180);
      state.settings.wipLimit = wip;
      state.settings.defaultTimerMin = def;
      state.settings.lowStim = !!$("#settingLowStim").checked;
      state.settings.nudges = !!$("#settingNudges").checked;
      state.settings.minimalMode = !!$("#settingMinimal").checked;
      if(state.settings.minimalMode) {
        state.settings.toolsCollapsed = true;
      }
      save();
      applyLowStim();
      applyMinimalMode();
      applyToolsCollapsed();
      renderToday();
      toast("Saved.");
    });
    $("#tagAdd").addEventListener("click", () => {
      const input = $("#tagInput");
      const tag = safeText(input.value);
      if(!tag) return;
      addTag(tag);
      input.value = "";
      renderAll();
    });
    $("#tagInput").addEventListener("keydown", (e) => {
      if(e.key === "Enter") { e.preventDefault(); $("#tagAdd").click(); }
    });
    $("#btnShowTips").addEventListener("click", () => {
      startOnboarding(true);
    });
    $("#btnFactoryReset").addEventListener("click", () => {
      if(!confirm("This clears all local app data on this browser. Continue?")) return;
      state = defaultState();
      save();
      selectedProjectId = null;
      selectedRoutineId = null;
      clearTimer();
      renderAll();
      toast("Reset complete.");
    });

    // quick reset
    $("#btnQuickReset").addEventListener("click", openReset);

    // export / import
    $("#btnExport").addEventListener("click", exportData);
    $("#importFile").addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if(file) importDataFromFile(file);
      e.target.value = "";
    });

    // initial state
    initFirestore();
    applyLowStim();
    applyMinimalMode();
    applyToolsCollapsed();
    setTimer(state.settings.defaultTimerMin);
    renderAll();
    showTool("tenMin"); // default helpful tool
    startOnboarding(false);

    window.addEventListener("online", () => {
      setBackupStatus("online");
      if(pendingBackup) scheduleBackup();
    });
    window.addEventListener("offline", () => {
      setBackupStatus("offline");
    });
  }

  init();

})();
