(() => {
  "use strict";

  const SOUND_KEY = "partial-lab-sound-v1";
  const TRACKER_KEY = "partial-lab-tracker-v1";
  const TRACKS = 4;
  const MAX_ROWS = 32;
  const PRESETS = {
    pure: [100, 0, 0, 0, 0, 0, 0, 0],
    warm: [100, 44, 22, 10, 6, 3, 1, 0],
    organ: [90, 78, 65, 47, 34, 24, 14, 8],
    bright: [100, 82, 68, 55, 43, 34, 25, 18],
    hollow: [100, 0, 66, 0, 38, 0, 23, 0]
  };
  const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const $ = id => document.getElementById(id);
  const dom = {
    play: $("play"), stop: $("stop"), bpm: $("bpm"), bpmValue: $("bpmValue"),
    length: $("patternLength"), tone: $("tone"), table: $("rows"), status: $("status"),
    dialog: $("noteDialog"), picker: $("notePicker"), gate: $("gatePicker"),
    velocity: $("velocityPicker"), editorLabel: $("editorLabel"),
    clear: $("clear"), demo: $("demo"), updateLabel: $("soundInfo")
  };
  const emptyPattern = () => Array.from({length: MAX_ROWS}, () => Array(TRACKS).fill(null));
  const defaultSound = () => ({
    levels: [...PRESETS.warm], attack: 30, release: 300,
    volume: 65, fold: 0, drive: 0, preset: "warm"
  });

  function safeLoad(key) {
    try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (_) { return null; }
  }
  function save() {
    try {
      localStorage.setItem(TRACKER_KEY, JSON.stringify({
        bpm: Number(dom.bpm.value), length: Number(dom.length.value),
        tone: dom.tone.value, pattern
      }));
    } catch (_) { /* storage may be disabled */ }
  }
  function sanitizeCell(value) {
    if (!value || !Number.isInteger(value.midi) || value.midi < 36 || value.midi > 84) return null;
    return {
      midi: value.midi,
      gate: [25, 50, 75, 100].includes(value.gate) ? value.gate : 75,
      velocity: [40, 65, 85, 100].includes(value.velocity) ? value.velocity : 85
    };
  }
  function examplePattern() {
    const result = emptyPattern();
    const bass = [48, null, null, null, 43, null, null, null, 45, null, null, null, 43, null, null, null];
    const lead = [60, null, 64, null, 67, null, 64, null, 62, null, 65, null, 67, null, 65, null];
    const upper = [null, null, 72, null, null, null, 74, null, null, null, 76, null, null, null, 74, null];
    for (let i = 0; i < 16; i++) {
      if (bass[i] !== null) result[i][0] = {midi: bass[i], gate: 100, velocity: 100};
      if (lead[i] !== null) result[i][1] = {midi: lead[i], gate: 75, velocity: 85};
      if (i === 0 || i === 8) result[i][2] = {midi: i === 0 ? 55 : 57, gate: 100, velocity: 65};
      if (upper[i] !== null) result[i][3] = {midi: upper[i], gate: 50, velocity: 65};
    }
    return result;
  }
  const stored = safeLoad(TRACKER_KEY);
  let pattern = Array.isArray(stored?.pattern)
    ? Array.from({length: MAX_ROWS}, (_, r) =>
        Array.from({length: TRACKS}, (_, t) => sanitizeCell(stored.pattern[r]?.[t])))
    : examplePattern();
  dom.bpm.value = Number.isFinite(stored?.bpm) ? Math.min(220, Math.max(50, Math.round(stored.bpm))) : 120;
  dom.length.value = stored?.length === 32 ? "32" : "16";
  dom.tone.value = ["shared", ...Object.keys(PRESETS)].includes(stored?.tone) ? stored.tone : "shared";

  const noteLabel = midi => NOTE_NAMES[midi % 12] + "-" + (Math.floor(midi / 12) - 1);
  const noteFrequency = midi => 440 * Math.pow(2, (midi - 69) / 12);
  const clamp01 = value => Math.max(0, Math.min(1, value));
  const smooth = value => { const x = clamp01(value); return x * x * (3 - 2 * x); };
  const foldSample = value => 1 - Math.abs((((value + 1) % 4) + 4) % 4 - 2);
  const smoothCurve = (from, to) => {
    const curve = new Float32Array(65);
    for (let i = 0; i < curve.length; i++) curve[i] = from + (to - from) * smooth(i / 64);
    return curve;
  };

  let audio = null, limiter = null, bus = null, wave = null, foldCurve = null, driveCurve = null;
  let playing = false, intervalId = null, animationId = null;
  let nextTime = 0, nextRow = 0, displayedRow = -1;
  let queuedRows = [];
  let currentSound = defaultSound();
  let editRow = -1, editTrack = -1;

  function readSound() {
    const storedSound = safeLoad(SOUND_KEY);
    const sound = defaultSound();
    if (storedSound && Array.isArray(storedSound.levels) &&
        storedSound.levels.length === 8 && storedSound.levels.every(v => Number.isFinite(v) && v >= 0 && v <= 100)) {
      sound.levels = [...storedSound.levels];
    }
    for (const key of ["attack", "release", "volume", "fold", "drive"]) {
      if (Number.isFinite(storedSound?.[key])) sound[key] = storedSound[key];
    }
    if (dom.tone.value !== "shared") sound.levels = [...PRESETS[dom.tone.value]];
    currentSound = sound;
    dom.updateLabel.textContent = dom.tone.value === "shared"
      ? "Using harmonics, envelope and effects from the Synth page"
      : "Using " + dom.tone.options[dom.tone.selectedIndex].text + " harmonics, with envelope and effects from the Synth page";
    return sound;
  }

  function render() {
    const total = Number(dom.length.value);
    const fragment = document.createDocumentFragment();
    for (let row = 0; row < total; row++) {
      const tr = document.createElement("tr");
      tr.dataset.step = String(row);
      if (row % 4 === 0) tr.classList.add("beat");
      const index = document.createElement("th");
      index.scope = "row";
      index.textContent = row.toString(16).toUpperCase().padStart(2, "0");
      tr.append(index);
      for (let track = 0; track < TRACKS; track++) {
        const td = document.createElement("td");
        const button = document.createElement("button");
        const note = pattern[row][track];
        button.type = "button";
        button.className = "note-cell" + (note ? " filled" : "");
        button.dataset.row = String(row);
        button.dataset.track = String(track);
        button.textContent = note ? noteLabel(note.midi) : "· · ·";
        button.setAttribute("aria-label", "Step " + (row + 1) + ", channel " + (track + 1)
          + ": " + (note ? noteLabel(note.midi) : "empty") + ". Edit note");
        button.title = note ? "Gate " + note.gate + "% · Velocity " + note.velocity + "%" : "Add note";
        td.append(button);
        tr.append(td);
      }
      fragment.append(tr);
    }
    dom.table.replaceChildren(fragment);
    markRow(displayedRow);
  }

  function markRow(row) {
    displayedRow = row;
    for (const tr of dom.table.rows) tr.classList.toggle("active-step", Number(tr.dataset.step) === row);
    if (row >= 0) {
      const active = dom.table.rows[row];
      if (active) {
        const box = active.getBoundingClientRect();
        const parent = active.closest(".grid-scroll").getBoundingClientRect();
        if (box.top < parent.top + 45 || box.bottom > parent.bottom - 12) active.scrollIntoView({block: "nearest"});
      }
    }
  }

  for (let midi = 36; midi <= 84; midi++) {
    const option = document.createElement("option");
    option.value = String(midi); option.textContent = noteLabel(midi);
    dom.picker.append(option);
  }
  dom.table.addEventListener("click", event => {
    const button = event.target.closest("button[data-row]");
    if (!button) return;
    editRow = Number(button.dataset.row);
    editTrack = Number(button.dataset.track);
    const note = pattern[editRow][editTrack];
    dom.editorLabel.textContent = "Step " + (editRow + 1) + " · Channel " + (editTrack + 1);
    dom.picker.value = note ? String(note.midi) : "";
    dom.gate.value = note ? String(note.gate) : "75";
    dom.velocity.value = note ? String(note.velocity) : "85";
    dom.dialog.showModal();
  });

  $("noteForm").addEventListener("submit", event => {
    event.preventDefault();
    if (editRow < 0 || editTrack < 0) return;
    const midi = dom.picker.value === "" ? null : Number(dom.picker.value);
    pattern[editRow][editTrack] = midi === null ? null : {
      midi, gate: Number(dom.gate.value), velocity: Number(dom.velocity.value)
    };
    dom.dialog.close();
    render(); save();
  });
  $("removeNote").addEventListener("click", () => {
    if (editRow >= 0 && editTrack >= 0) pattern[editRow][editTrack] = null;
    dom.dialog.close(); render(); save();
  });
  $("cancelNote").addEventListener("click", () => dom.dialog.close());
  dom.bpm.addEventListener("input", () => {
    dom.bpmValue.textContent = dom.bpm.value + " BPM";
    save();
  });
  dom.length.addEventListener("change", () => { stop(); render(); save(); });
  dom.tone.addEventListener("change", () => { readSound(); save(); });
  dom.clear.addEventListener("click", () => { stop(); pattern = emptyPattern(); render(); save(); });
  dom.demo.addEventListener("click", () => { stop(); pattern = examplePattern(); render(); save(); });

  function shapeCurve(fn) {
    const curve = new Float32Array(4097);
    for (let i = 0; i < curve.length; i++) curve[i] = fn(2 * i / 4096 - 1);
    return curve;
  }
  function ensureAudio() {
    if (audio) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error("Web Audio is not supported in this browser.");
    audio = new AC();
    limiter = audio.createDynamicsCompressor();
    limiter.threshold.value = -17;
    limiter.knee.value = 12;
    limiter.ratio.value = 3.5;
    limiter.attack.value = .004;
    limiter.release.value = .18;
    limiter.connect(audio.destination);
    foldCurve = shapeCurve(x => foldSample(x * 5));
    driveCurve = shapeCurve(x => Math.tanh(x * 7));
  }
  function createBus() {
    bus = audio.createGain();
    bus.gain.value = clamp01(currentSound.volume / 100) * .55;
    bus.connect(limiter);
  }
  function generateWave() {
    const real = new Float32Array(9);
    const imaginary = new Float32Array(9);
    for (let i = 0; i < 8; i++) imaginary[i + 1] = currentSound.levels[i] / 100;
    wave = audio.createPeriodicWave(real, imaginary, {disableNormalization: false});
  }
  function makeEffect(kind, amount) {
    const input = audio.createGain();
    const output = audio.createGain();
    const dry = audio.createGain();
    const pre = audio.createGain();
    const shaper = audio.createWaveShaper();
    const makeup = audio.createGain();
    const wet = audio.createGain();
    shaper.curve = kind === "fold" ? foldCurve : driveCurve;
    shaper.oversample = "2x";
    const level = clamp01(amount);
    const preLevel = kind === "fold" ? .2 + level * .8 : .14 + level * .86;
    dry.gain.value = 1 - level;
    wet.gain.value = level;
    pre.gain.value = preLevel;
    makeup.gain.value = kind === "fold" ? 1 : 1 / Math.tanh(preLevel * 7);
    input.connect(dry); dry.connect(output);
    input.connect(pre); pre.connect(shaper); shaper.connect(makeup); makeup.connect(wet); wet.connect(output);
    return {input, output, nodes: [input, output, dry, pre, shaper, makeup, wet]};
  }
  function scheduleNote(note, when, stepSeconds) {
    if (!note) return;
    const duration = stepSeconds * note.gate / 100;
    const attack = Math.min(Math.max(.005, currentSound.attack / 1000), Math.max(.005, duration * .42));
    const release = Math.max(.03, currentSound.release / 1000);
    const level = .23 * note.velocity / 100;
    const osc = audio.createOscillator();
    const amp = audio.createGain();
    const folder = makeEffect("fold", currentSound.fold / 100);
    const overdrive = makeEffect("drive", currentSound.drive / 100);
    osc.frequency.value = noteFrequency(note.midi);
    osc.setPeriodicWave(wave);
    osc.connect(folder.input);
    folder.output.connect(overdrive.input);
    overdrive.output.connect(amp);
    amp.connect(bus);
    const start = when + .004;
    const releaseAt = start + Math.max(duration, attack + .001);
    amp.gain.setValueAtTime(0, when);
    amp.gain.setValueCurveAtTime(smoothCurve(0, level), start, attack);
    amp.gain.setValueAtTime(level, releaseAt);
    amp.gain.setValueCurveAtTime(smoothCurve(level, 0), releaseAt, release);
    osc.start(start);
    osc.stop(releaseAt + release + .03);
    osc.onended = () => {
      osc.disconnect(); amp.disconnect();
      for (const node of [...folder.nodes, ...overdrive.nodes]) node.disconnect();
    };
  }
  function stepSeconds() { return 60 / Number(dom.bpm.value) / 4; }
  function schedule() {
    if (!playing || !audio || audio.state !== "running") return;
    const limit = audio.currentTime + .12;
    while (nextTime < limit) {
      const interval = stepSeconds();
      const row = nextRow;
      for (const note of pattern[row]) scheduleNote(note, nextTime, interval);
      queuedRows.push({row, when: nextTime});
      nextTime += interval;
      nextRow = (nextRow + 1) % Number(dom.length.value);
    }
  }
  function animate() {
    if (!playing) return;
    while (queuedRows.length && queuedRows[0].when <= audio.currentTime) {
      markRow(queuedRows.shift().row);
    }
    animationId = requestAnimationFrame(animate);
  }
  async function start() {
    if (playing) return;
    try {
      ensureAudio();
      await audio.resume();
      readSound();
      generateWave();
      createBus();
      nextTime = audio.currentTime + .055;
      nextRow = 0;
      queuedRows = [];
      playing = true;
      dom.play.disabled = true;
      dom.stop.disabled = false;
      dom.status.textContent = "Playing";
      markRow(-1);
      intervalId = setInterval(schedule, 25);
      schedule();
      animate();
    } catch (error) {
      stop();
      dom.status.textContent = error.message || "Could not start audio";
    }
  }
  function stop() {
    playing = false;
    if (intervalId !== null) clearInterval(intervalId);
    if (animationId !== null) cancelAnimationFrame(animationId);
    intervalId = null; animationId = null;
    if (bus && audio) {
      // Fade a stopped pattern, including notes already scheduled just ahead.
      bus.gain.cancelScheduledValues(audio.currentTime);
      bus.gain.setTargetAtTime(0, audio.currentTime, .01);
    }
    queuedRows = [];
    markRow(-1);
    dom.play.disabled = false;
    dom.stop.disabled = true;
    dom.status.textContent = "Stopped";
  }
  dom.play.addEventListener("click", start);
  dom.stop.addEventListener("click", stop);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
  window.addEventListener("pagehide", stop);
  window.addEventListener("storage", event => { if (event.key === SOUND_KEY && !playing) readSound(); });

  dom.bpmValue.textContent = dom.bpm.value + " BPM";
  readSound();
  render();
})();