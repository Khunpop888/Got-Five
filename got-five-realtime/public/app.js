const app = document.querySelector("#app");
const toastBox = document.querySelector("#toast");

const TILE_NAMES = ["เขียว", "ชมพู", "ฟ้า", "แดง", "ส้ม"];
const FALLBACK_COLORS = [
  { key: "cyan", name: "Cyan", hex: "#00a7c7" },
  { key: "blue", name: "Blue", hex: "#2563eb" },
  { key: "teal", name: "Teal", hex: "#0d9488" },
  { key: "violet", name: "Violet", hex: "#7c3aed" },
  { key: "indigo", name: "Indigo", hex: "#4f46e5" },
  { key: "rose", name: "Rose", hex: "#e11d48" },
  { key: "pink", name: "Pink", hex: "#db2777" },
  { key: "red", name: "Red", hex: "#dc2626" },
  { key: "amber", name: "Amber", hex: "#f59e0b" },
  { key: "orange", name: "Orange", hex: "#ea580c" },
  { key: "emerald", name: "Emerald", hex: "#059669" },
  { key: "lime", name: "Lime", hex: "#65a30d" },
  { key: "slate", name: "Slate", hex: "#475569" },
  { key: "zinc", name: "Zinc", hex: "#3f3f46" },
];
const SAVED_PLAYER_NAME = localStorage.getItem("gotfive.name") || "";
const SAVED_OWNER_KEY = sessionStorage.getItem("gotfive.ownerKey") || "";
const SAVED_SOUND_ENABLED = localStorage.getItem("gotfive.soundEnabled") !== "false";
const START_PARAMS = new URLSearchParams(location.search);
const START_OWNER_MODE = location.pathname === "/owner" || START_PARAMS.get("owner") === "1" || sessionStorage.getItem("gotfive.ownerMode") === "1" || Boolean(SAVED_OWNER_KEY);

const ui = {
  connected: false,
  socket: null,
  reconnectTimer: null,
  pendingAvatarSync: false,
  validatingRoom: false,
  state: null,
  name: SAVED_PLAYER_NAME === "Pop" ? "" : SAVED_PLAYER_NAME,
  ownerMode: START_OWNER_MODE,
  ownerKey: SAVED_OWNER_KEY,
  createCode: "",
  color: localStorage.getItem("gotfive.color") || "cyan",
  avatar: localStorage.getItem("gotfive.avatar") || "",
  maxPlayers: 4,
  matchTotal: Math.min(5, Math.max(1, Number(localStorage.getItem("gotfive.matchTotal") || 1) || 1)),
  joinCode: roomCodeFromPath() || "",
  selectedCenterTileId: null,
  responderId: null,
  compareMode: false,
  showCategoriseConfirm: false,
  showGuess: false,
  guessResult: null,
  chatDraft: "",
  chatOpen: false,
  chatReadCount: 0,
  lastEvent: null,
  soundEnabled: SAVED_SOUND_ENABLED,
};

let pendingServerRender = null;

const gameAudio = {
  context: null,
  master: null,
  userActivated: false,
};

function setupSoundControls() {
  updateSoundToggle();
  document.querySelector("#sound-toggle")?.addEventListener("click", () => {
    gameAudio.userActivated = true;
    ui.soundEnabled = !ui.soundEnabled;
    localStorage.setItem("gotfive.soundEnabled", String(ui.soundEnabled));
    updateSoundToggle();
    if (gameAudio.master && gameAudio.context) {
      gameAudio.master.gain.cancelScheduledValues(gameAudio.context.currentTime);
      gameAudio.master.gain.setTargetAtTime(ui.soundEnabled ? 0.72 : 0.0001, gameAudio.context.currentTime, 0.015);
    }
    if (ui.soundEnabled) playSound("confirm");
  });
  document.addEventListener("click", handleUiClickSound, true);
  document.addEventListener("change", (event) => {
    if (!event.target.closest("select")) return;
    unlockAudio();
    playSound("select");
  }, true);
}

function updateSoundToggle() {
  const button = document.querySelector("#sound-toggle");
  if (!button) return;
  button.classList.toggle("is-muted", !ui.soundEnabled);
  button.setAttribute("aria-pressed", String(ui.soundEnabled));
  button.setAttribute("aria-label", ui.soundEnabled ? "ปิดเสียงเกม" : "เปิดเสียงเกม");
  const icon = button.querySelector(".sound-toggle-icon");
  const label = button.querySelector(".sound-toggle-label");
  if (icon) icon.textContent = ui.soundEnabled ? "🔊" : "🔇";
  if (label) label.textContent = ui.soundEnabled ? "เสียง: เปิด" : "เสียง: ปิด";
  document.documentElement.dataset.sound = ui.soundEnabled ? "on" : "off";
}

function handleUiClickSound(event) {
  const control = event.target.closest("button, a.btn, [role='button']");
  if (!control || control.disabled || control.getAttribute("aria-disabled") === "true") return;
  unlockAudio();
  if (control.id === "sound-toggle") return;
  if (control.matches("[data-mark]")) {
    playSound(control.classList.contains("is-marked") ? "markOff" : "markOn");
    return;
  }
  if (control.id === "submit-guess") {
    playSound("guessSubmit");
    return;
  }
  if (control.id === "send-chat") {
    playSound("messageSend");
    return;
  }
  if (control.matches("[data-color], [data-center-tile], [data-secret-slot], [data-draw]")) {
    playSound("select");
    return;
  }
  if (control.matches("#cancel-guess, #cancel-categorise, [data-cancel-compare]")) {
    playSound("cancel");
    return;
  }
  if (control.matches("#open-guess, #do-categorise, #start-compare")) {
    playSound("open");
    return;
  }
  if (control.matches(".primary, .rose, #confirm-categorise")) {
    playSound("confirm");
    return;
  }
  playSound("click");
}

function unlockAudio() {
  gameAudio.userActivated = true;
  if (!ui.soundEnabled) return;
  const context = ensureAudioContext();
  if (!context) return;
  if (context.state === "suspended") {
    context.resume().then(() => {
      document.documentElement.dataset.audioReady = "true";
    }).catch(() => {});
  } else {
    document.documentElement.dataset.audioReady = "true";
  }
}

function ensureAudioContext() {
  if (gameAudio.context) return gameAudio.context;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  try {
    const context = new AudioContextClass();
    const master = context.createGain();
    master.gain.value = ui.soundEnabled ? 0.72 : 0.0001;
    master.connect(context.destination);
    gameAudio.context = context;
    gameAudio.master = master;
    return context;
  } catch {
    return null;
  }
}

function soundTone(context, frequency, offset, duration, options = {}) {
  const start = context.currentTime + Math.max(0, offset);
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = options.type || "sine";
  oscillator.frequency.setValueAtTime(Math.max(30, frequency), start);
  if (options.endFrequency) {
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(30, options.endFrequency), start + duration);
  }
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(options.volume || 0.12, start + Math.min(0.025, duration * 0.3));
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(gameAudio.master);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function soundNoise(context, offset, duration, options = {}) {
  const frameCount = Math.max(1, Math.floor(context.sampleRate * duration));
  const buffer = context.createBuffer(1, frameCount, context.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < frameCount; index += 1) {
    channel[index] = (Math.random() * 2 - 1) * (1 - index / frameCount);
  }
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();
  const start = context.currentTime + Math.max(0, offset);
  source.buffer = buffer;
  filter.type = options.filterType || "bandpass";
  filter.frequency.value = options.frequency || 900;
  filter.Q.value = options.q || 0.8;
  gain.gain.setValueAtTime(options.volume || 0.045, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(gameAudio.master);
  source.start(start);
  source.stop(start + duration + 0.02);
}

function playSound(name, options = {}) {
  if (!ui.soundEnabled || !gameAudio.userActivated) return;
  const context = ensureAudioContext();
  if (!context || !gameAudio.master) return;
  if (context.state === "suspended") context.resume().catch(() => {});
  const delay = Math.max(0, Number(options.delay || 0));
  const tone = (frequency, offset, duration, config = {}) => soundTone(context, frequency, delay + offset, duration, config);
  const noise = (offset, duration, config = {}) => soundNoise(context, delay + offset, duration, config);

  if (name === "click") {
    tone(520, 0, 0.045, { type: "triangle", endFrequency: 610, volume: 0.055 });
  } else if (name === "select") {
    tone(440, 0, 0.07, { type: "triangle", volume: 0.07 });
    tone(660, 0.055, 0.08, { type: "sine", volume: 0.065 });
  } else if (name === "open") {
    tone(330, 0, 0.08, { type: "triangle", volume: 0.075 });
    tone(495, 0.06, 0.11, { type: "triangle", volume: 0.08 });
  } else if (name === "confirm") {
    tone(523, 0, 0.075, { type: "triangle", volume: 0.08 });
    tone(784, 0.065, 0.13, { type: "sine", volume: 0.085 });
  } else if (name === "cancel") {
    tone(410, 0, 0.08, { type: "triangle", volume: 0.07 });
    tone(275, 0.055, 0.12, { type: "sine", volume: 0.07 });
  } else if (name === "markOn") {
    noise(0, 0.07, { frequency: 260, filterType: "lowpass", volume: 0.055 });
    tone(150, 0, 0.09, { type: "square", endFrequency: 110, volume: 0.035 });
  } else if (name === "markOff") {
    tone(240, 0, 0.07, { type: "triangle", volume: 0.055 });
    tone(380, 0.05, 0.09, { type: "sine", volume: 0.06 });
  } else if (name === "draw") {
    noise(0, 0.22, { frequency: 1250, volume: 0.05 });
    tone(220, 0, 0.2, { type: "sawtooth", endFrequency: 660, volume: 0.045 });
    tone(880, 0.18, 0.13, { type: "triangle", volume: 0.085 });
  } else if (name === "categorise") {
    tone(294, 0, 0.1, { type: "triangle", volume: 0.085 });
    tone(440, 0.09, 0.1, { type: "triangle", volume: 0.085 });
    tone(587, 0.18, 0.15, { type: "sine", volume: 0.09 });
  } else if (name === "compareYes") {
    tone(392, 0, 0.11, { type: "triangle", volume: 0.09 });
    tone(587, 0.1, 0.14, { type: "triangle", volume: 0.1 });
    tone(784, 0.2, 0.2, { type: "sine", volume: 0.085 });
  } else if (name === "compareNo") {
    tone(440, 0, 0.13, { type: "triangle", volume: 0.085 });
    tone(294, 0.11, 0.18, { type: "sine", volume: 0.09 });
  } else if (name === "myTurn") {
    tone(659, 0, 0.16, { type: "sine", volume: 0.1 });
    tone(784, 0.12, 0.18, { type: "sine", volume: 0.1 });
    tone(988, 0.24, 0.28, { type: "sine", volume: 0.11 });
  } else if (name === "stepReady") {
    tone(523, 0, 0.09, { type: "triangle", volume: 0.08 });
    tone(698, 0.075, 0.12, { type: "triangle", volume: 0.085 });
  } else if (name === "matchStart") {
    tone(262, 0, 0.15, { type: "triangle", volume: 0.08 });
    tone(392, 0.12, 0.16, { type: "triangle", volume: 0.085 });
    tone(523, 0.24, 0.24, { type: "sine", volume: 0.1 });
  } else if (name === "guessSubmit") {
    tone(220, 0, 0.08, { type: "triangle", volume: 0.075 });
    tone(277, 0.07, 0.08, { type: "triangle", volume: 0.08 });
    tone(330, 0.14, 0.12, { type: "triangle", volume: 0.085 });
    tone(440, 0.22, 0.18, { type: "sine", volume: 0.09 });
  } else if (name === "guessCorrect") {
    noise(0.05, 0.3, { frequency: 2800, filterType: "highpass", volume: 0.045 });
    [523, 659, 784, 1047].forEach((frequency, index) => tone(frequency, index * 0.1, 0.25, { type: "triangle", volume: 0.105 }));
  } else if (name === "guessWrong") {
    tone(392, 0, 0.18, { type: "sawtooth", volume: 0.07 });
    tone(294, 0.15, 0.2, { type: "triangle", volume: 0.09 });
    tone(196, 0.32, 0.3, { type: "sine", volume: 0.105 });
  } else if (name === "roundEnd") {
    noise(0.08, 0.38, { frequency: 3200, filterType: "highpass", volume: 0.04 });
    [392, 523, 659, 784].forEach((frequency, index) => tone(frequency, index * 0.12, 0.3, { type: "triangle", volume: 0.095 }));
  } else if (name === "seriesEnd") {
    noise(0.08, 0.7, { frequency: 3000, filterType: "highpass", volume: 0.055 });
    [262, 330, 392, 523, 659, 784, 1047].forEach((frequency, index) => tone(frequency, index * 0.11, 0.36, { type: index < 3 ? "triangle" : "sine", volume: 0.105 }));
    tone(523, 0.82, 0.7, { type: "sine", volume: 0.09 });
    tone(659, 0.82, 0.7, { type: "sine", volume: 0.08 });
    tone(784, 0.82, 0.7, { type: "sine", volume: 0.075 });
  } else if (name === "messageIncoming") {
    tone(740, 0, 0.07, { type: "sine", volume: 0.06 });
    tone(930, 0.055, 0.1, { type: "sine", volume: 0.065 });
  } else if (name === "messageSend") {
    tone(580, 0, 0.06, { type: "triangle", volume: 0.06 });
    tone(820, 0.045, 0.09, { type: "sine", volume: 0.065 });
  } else if (name === "playerJoin") {
    tone(440, 0, 0.09, { type: "triangle", volume: 0.065 });
    tone(554, 0.07, 0.11, { type: "triangle", volume: 0.07 });
  } else if (name === "error") {
    tone(180, 0, 0.16, { type: "square", endFrequency: 120, volume: 0.05 });
  }
}

function handleStateAudio(previousState, nextState, eventData, packetEvent) {
  if (!previousState || !nextState) return;
  const previousStatus = previousState.room?.status;
  const nextStatus = nextState.room?.status;
  const meId = nextState.me?.id;

  const soundEvents = eventData?.type === "batch" ? (eventData.events || []) : (eventData ? [eventData] : []);
  soundEvents.forEach((soundEvent, index) => {
    const eventDelay = index * 0.34;
    if (soundEvent.type === "draw") {
      playSound("draw", { delay: eventDelay });
      if (soundEvent.actorId === meId) playSound("stepReady", { delay: eventDelay + 0.32 });
    } else if (soundEvent.type === "categorise") {
      playSound("categorise", { delay: eventDelay });
    } else if (soundEvent.type === "compare") {
      playSound(soundEvent.isSame ? "compareYes" : "compareNo", { delay: eventDelay });
    } else if (soundEvent.type === "gotfive") {
      playSound(soundEvent.isCorrect ? "guessCorrect" : "guessWrong", { delay: eventDelay });
    }
  });
  const gotFiveEvent = soundEvents.find((soundEvent) => soundEvent.type === "gotfive");
  const actionSoundDuration = soundEvents.length > 1 ? soundEvents.length * 0.34 : 0;

  if (previousStatus === "lobby" && nextStatus === "playing") {
    playSound("matchStart");
    if (nextState.turnPlayerId === meId) playSound("myTurn", { delay: 0.55 });
  } else if (previousStatus === "playing" && nextStatus === "between_matches") {
    playSound("roundEnd", { delay: gotFiveEvent ? actionSoundDuration + 0.55 : actionSoundDuration });
  } else if (previousStatus === "playing" && nextStatus === "finished") {
    playSound("seriesEnd", { delay: gotFiveEvent ? actionSoundDuration + 0.55 : actionSoundDuration });
  } else if (nextStatus === "playing") {
    const becameMyTurn = previousState.turnPlayerId !== meId && nextState.turnPlayerId === meId;
    if (becameMyTurn) playSound("myTurn", { delay: soundEvents.length ? actionSoundDuration + 0.28 : 0 });
    const advancedToAction = previousState.turnPlayerId === meId
      && nextState.turnPlayerId === meId
      && previousState.room?.phase !== "action"
      && nextState.room?.phase === "action";
    if (advancedToAction && eventData?.type !== "draw") playSound("stepReady");
  }

  const previousPlayers = previousState.players?.length || 0;
  const nextPlayers = nextState.players?.length || 0;
  if (nextStatus === "lobby" && previousState.room?.code === nextState.room?.code && nextPlayers > previousPlayers) {
    playSound("playerJoin");
  }
  const previousChat = previousState.chat?.length || 0;
  const nextChat = nextState.chat?.length || 0;
  const latestChat = nextState.chat?.[nextChat - 1];
  if (packetEvent === "chat" && nextChat > previousChat && latestChat?.playerId !== meId) {
    playSound("messageIncoming");
  }
}

setupSoundControls();
connect();
setInterval(updateClocks, 1000);
setInterval(sendHeartbeat, 25000);

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  ui.socket = socket;

  socket.addEventListener("open", () => {
    ui.connected = true;
    const routeCode = roomCodeFromPath();
    const token = routeCode ? getSessionToken(routeCode) : "";
    if (routeCode && token) {
      ui.validatingRoom = true;
      send("joinRoom", { code: routeCode, name: ui.name, color: ui.color, sessionToken: token });
    } else if (ui.state?.room?.code) {
      send("sync");
    }
    render();
  });

  socket.addEventListener("message", (event) => {
    let packet;
    try {
      packet = JSON.parse(event.data);
    } catch {
      return;
    }
    if (packet.event === "connected" || packet.event === "pong") return;
    if (packet.event === "markUpdated") {
      applyMarkUpdate(packet.data);
      return;
    }
    if (packet.event === "roomJoined" || packet.event === "state" || packet.event === "chat") {
      const isRedundantSync = packet.event === "state"
        && !packet.data?.eventData
        && ui.state?.room?.revision === packet.data?.room?.revision;
      if (isRedundantSync) return;
      ui.validatingRoom = false;
      const previousState = ui.state;
      ui.state = packet.data;
      const chatLength = packet.data?.chat?.length || 0;
      if (packet.event === "roomJoined" || ui.chatOpen) {
        ui.chatReadCount = chatLength;
      }
      if (packet.data?.me?.sessionToken && packet.data?.room?.code) {
        setSessionToken(packet.data.room.code, packet.data.me.sessionToken);
        history.replaceState(null, "", `/room/${encodeURIComponent(packet.data.room.code)}`);
      }
      syncIdentityFromState(packet.data);
      syncPendingAvatar(packet.event, packet.data);
      if (packet.data?.eventData) {
        ui.lastEvent = packet.data.eventData;
        window.setTimeout(() => {
          ui.lastEvent = null;
          scheduleServerRender();
        }, 900);
      }
      reconcileLocalSelection();
      handleStateAudio(previousState, packet.data, packet.data?.eventData, packet.event);
      scheduleServerRender();
      return;
    }
    if (packet.event === "guessResult") {
      ui.guessResult = packet.data;
      ui.showGuess = false;
      render();
      return;
    }
    if (packet.event === "error") {
      playSound("error");
      handleServerError(packet.data?.message || "เกิดข้อผิดพลาด");
    }
  });

  socket.addEventListener("close", () => {
    ui.connected = false;
    render();
    clearTimeout(ui.reconnectTimer);
    ui.reconnectTimer = setTimeout(connect, 1200);
  });
}

function send(event, data = {}) {
  if (!ui.socket || ui.socket.readyState !== WebSocket.OPEN) {
    showToast("ยังไม่ได้เชื่อมต่อ server");
    return false;
  }
  ui.socket.send(JSON.stringify({ event, data }));
  return true;
}

function sendHeartbeat() {
  if (!ui.connected || ui.validatingRoom || !ui.state?.room?.code) return;
  if (!ui.socket || ui.socket.readyState !== WebSocket.OPEN) return;
  ui.socket.send(JSON.stringify({ event: "ping", data: {} }));
}

function handleServerError(message) {
  const text = message || "เกิดข้อผิดพลาด";
  const routeCode = roomCodeFromPath();
  if (routeCode && text.includes("ไม่พบห้องนี้")) {
    clearSessionToken(routeCode);
    ui.state = null;
    ui.joinCode = routeCode;
    ui.validatingRoom = false;
    history.replaceState(null, "", "/");
    showToast("ห้องนี้หมดอายุหรือ server restart แล้ว กรุณาสร้างห้องใหม่");
    render();
    return;
  }
  ui.validatingRoom = false;
  showToast(text);
}

function render() {
  if (!ui.connected && !ui.state) {
    document.body.dataset.view = "loading";
    app.innerHTML = renderLoading();
    return;
  }
  if (!ui.state) {
    document.body.dataset.view = "start";
    app.innerHTML = renderStart();
    bindStart();
    return;
  }
  if (ui.state.room.status === "lobby") {
    document.body.dataset.view = "lobby";
    app.innerHTML = renderLobby();
    bindLobby();
    return;
  }
  document.body.dataset.view = "game";
  app.innerHTML = renderGame();
  bindGame();
  updateClocks();
  scrollListsToEnd();
}

function scheduleServerRender() {
  if (pendingServerRender !== null) return;
  pendingServerRender = requestAnimationFrame(() => {
    pendingServerRender = null;
    render();
  });
}

function renderLoading() {
  return `
    <section class="loading-screen">
      <div class="brand-block">
        <div class="hero-panel">
          <div>
            <span class="brand-kicker">Realtime Table</span>
            <h1>GOT FIVE!</h1>
            <p>กำลังเชื่อมต่อโต๊ะเกม...</p>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderStart() {
  const palette = ui.state?.playerColors || FALLBACK_COLORS;
  const showCreator = ui.ownerMode;
  return `
    <section class="start-screen">
      <div class="brand-block">
        <div class="hero-panel">
          <div>
            <span class="brand-kicker">Realtime Multiplayer</span>
            <h1>GOT FIVE!</h1>
            <p>โต๊ะเกมออนไลน์สำหรับเล่นผ่าน browser บน PC และมือถือ เจ้าของสร้างห้องแล้วส่งลิงก์ให้เพื่อนเข้ามาได้ทันที</p>
          </div>
          <div class="visual-strip single">
            <img src="/assets/got-five-product.jpg" alt="Got Five game set">
          </div>
        </div>

        <section class="start-panel">
          <div class="form-stack">
            <div>
              <h2>${showCreator ? "จัดโต๊ะเกม" : "เข้าโต๊ะเกม"}</h2>
              <p class="helper">${showCreator ? "ตั้งชื่อ เลือกสี แล้วสร้างห้องเชิญเพื่อนหรือเข้าห้องจากรหัส" : "ตั้งชื่อ เลือกสี แล้วเข้าจากลิงก์เชิญหรือรหัสห้อง"}</p>
            </div>
            <label class="field">
              <span>ชื่อผู้เล่น</span>
              <input id="start-name" class="input" maxlength="24" value="${escapeHtml(ui.name)}" placeholder="พิมพ์ชื่อของคุณ">
            </label>
            ${renderAvatarPicker("start", ui.avatar, ui.name, ui.color)}
            <div class="field">
              <span class="field-label">สีประจำตัว</span>
              <div class="swatches">
                ${palette.map((color) => renderSwatch(color, ui.color)).join("")}
              </div>
            </div>
            ${showCreator ? `
              <div class="creator-panel">
                <label class="field">
                  <span>รหัสใช้งาน</span>
                  <input id="owner-key" class="input" type="password" autocomplete="off" value="${escapeHtml(ui.ownerKey)}" placeholder="ใส่รหัสสำหรับเปิดโต๊ะ">
                </label>
                <label class="field">
                  <span>ตั้งรหัสห้อง</span>
                  <input id="create-code" class="input" maxlength="24" value="${escapeHtml(ui.createCode)}" placeholder="เช่น ไส้ตัน หรือ enjoy">
                </label>
                <label class="field">
                  <span>จำนวนผู้เล่นสูงสุด</span>
                  <select id="max-players" class="select">
                    ${[2, 3, 4].map((count) => `<option value="${count}" ${ui.maxPlayers === count ? "selected" : ""}>${count} คน</option>`).join("")}
                  </select>
                </label>
                <label class="field">
                  <span>จำนวนเกมแข่งขัน</span>
                  <select id="match-total" class="select">
                    ${[1, 2, 3, 4, 5].map((count) => `<option value="${count}" ${ui.matchTotal === count ? "selected" : ""}>${count} เกม</option>`).join("")}
                  </select>
                </label>
                <div class="button-row start-actions">
                  <button id="create-room" class="btn primary">สร้างห้องเชิญเพื่อน</button>
                  <a class="btn ghost" href="/how-to-play.html" target="_blank" rel="noopener">วิธีเล่น</a>
                </div>
              </div>
            ` : `
              <div class="button-row start-actions">
                <a class="btn ghost" href="/how-to-play.html" target="_blank" rel="noopener">วิธีเล่น</a>
              </div>
            `}
            <div class="field">
              <span class="field-label">รหัสห้อง</span>
              <div class="button-row">
                <input id="join-code" class="input" maxlength="24" value="${escapeHtml(ui.joinCode)}" placeholder="เช่น ไส้ตัน หรือ enjoy">
                <button id="join-room" class="btn violet">เข้าห้อง</button>
              </div>
            </div>
            <p class="helper">${ui.connected ? "สถานะ: ออนไลน์กับ server" : "สถานะ: กำลัง reconnect"}</p>
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderLobby() {
  const s = ui.state;
  const me = getMe();
  const palette = s.playerColors || FALLBACK_COLORS;
  const invite = inviteLink();
  const canStart = me?.isHost && s.players.length >= 2;
  return `
    <section class="lobby-screen">
      <div class="brand-block">
        <div class="hero-panel">
          <div>
            <span class="brand-kicker">Room ${escapeHtml(s.room.code)}</span>
            <h1>GOT FIVE!</h1>
            <p>รอผู้เล่น ${s.players.length}/${s.room.maxPlayers} คน</p>
          </div>
          <div class="visual-strip single">
            <img src="/assets/got-five-product.jpg" alt="Got Five game set">
          </div>
        </div>

        <section class="lobby-panel">
          <div class="form-stack">
            <div class="button-row">
              <span class="status-pill">รหัส ${escapeHtml(s.room.code)}</span>
              <button id="copy-invite" class="btn ghost">Copy Invite</button>
              <a class="btn ghost" href="/how-to-play.html" target="_blank" rel="noopener">วิธีเล่น</a>
            </div>
            <input class="input" value="${escapeHtml(invite)}" readonly>

            <label class="field">
              <span>ชื่อผู้เล่น</span>
              <input id="lobby-name" class="input" maxlength="24" value="${escapeHtml(me?.name || ui.name)}">
            </label>
            ${renderAvatarPicker("lobby", me?.avatar || ui.avatar, me?.name || ui.name, me?.color || ui.color)}
            <div class="field">
              <span class="field-label">สีประจำตัว</span>
              <div class="swatches">
                ${palette.map((color) => renderSwatch(color, me?.color || ui.color)).join("")}
              </div>
            </div>
            <label class="field">
              <span>จำนวนเกมแข่งขัน</span>
              <select id="lobby-match-total" class="select" ${me?.isHost ? "" : "disabled"}>
                ${[1, 2, 3, 4, 5].map((count) => `<option value="${count}" ${s.room.matchTotal === count ? "selected" : ""}>${count} เกม</option>`).join("")}
              </select>
            </label>
            <button id="save-profile" class="btn ghost">บันทึกโปรไฟล์</button>

            <div>
              <h2>ผู้เล่นในห้อง</h2>
              <div class="lobby-list">
                ${s.players.map((player) => renderLobbyPlayer(player, me)).join("")}
              </div>
            </div>

            <div class="button-row">
              <button id="add-bot" class="btn amber" ${!me?.isHost || s.players.length >= s.room.maxPlayers ? "disabled" : ""}>เพิ่ม Bot</button>
              <button id="start-game" class="btn primary" ${canStart ? "" : "disabled"}>เริ่มเกม</button>
            </div>
            <p class="helper">${me?.isHost ? "เจ้าของห้องเป็นคนเริ่มเกม" : "รอเจ้าของห้องเริ่มเกม"}</p>
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderGame() {
  const s = ui.state;
  const me = getMe();
  const current = s.players.find((player) => player.id === s.turnPlayerId);
  const starterId = s.room.starterId || s.log.find((item) => item.payload?.starterId)?.payload?.starterId;
  const starter = s.players.find((player) => player.id === starterId);
  const round = getRoundInfo(s);
  const series = s.series || { current: s.room.matchIndex || 1, total: s.room.matchTotal || 1, completed: 0 };
  const statusText = s.room.status === "finished"
    ? "จบซีรีส์แล้ว"
    : s.room.status === "between_matches"
      ? `จบเกมที่ ${series.completed}/${series.total} · รอเกมถัดไป`
      : current ? `ตาของ ${current.name} (${phaseName(s.room.phase)})` : "กำลังรอ";
  const opponents = s.players.filter((player) => player.id !== me?.id);
  const isMyTurn = s.turnPlayerId === me?.id && me?.active && s.room.status === "playing";
  const canDraw = isMyTurn && s.room.phase === "draw";
  const canAction = isMyTurn && s.room.phase === "action";

  return `
    <section class="game-screen ${ui.compareMode ? "is-compare-picking" : ""}">
      <header class="topbar ${isMyTurn ? "is-my-turn" : ""}">
        <div>
          <h1>GOT FIVE!</h1>
          <div class="topbar-meta">
            <span class="small-pill dark">Room ${escapeHtml(s.room.code)}</span>
            <span class="small-pill dark">${escapeHtml(statusText)}</span>
            ${s.room.status === "playing" ? `<span class="small-pill dark turn-time-pill">ตานี้ <b data-turn-clock-start="${s.room.turnStartedAt || ""}">00:00</b></span>` : ""}
            <span class="small-pill dark">เกมที่ ${series.current}/${series.total}</span>
            <span class="small-pill dark" data-clock-start="${s.room.startedAt || ""}" data-clock-end="${s.room.endedAt || ""}">00:00</span>
            <span class="small-pill dark">รอบที่ ${round.current} · คนที่ ${round.position}/${round.total}</span>
            ${starter ? `<span class="small-pill dark starter-pill">สุ่มเริ่ม: ${escapeHtml(starter.name)}</span>` : ""}
          </div>
        </div>
        <div class="button-row topbar-actions">
          <button id="copy-invite" class="btn ghost">Copy Invite</button>
          <a class="btn ghost" href="/how-to-play.html" target="_blank" rel="noopener">วิธีเล่น</a>
          ${s.room.status === "playing" && me?.active ? `<button id="open-guess" class="btn rose">GOT FIVE!</button>` : ""}
          ${me?.isHost && s.room.status === "between_matches" ? `<button id="next-match" class="btn primary">เริ่มเกมถัดไป</button>` : ""}
          ${me?.isHost ? `<button id="restart-room" class="btn ghost">${s.room.status === "finished" || s.room.status === "between_matches" ? "กลับ Lobby" : "Reset"}</button>` : ""}
        </div>
      </header>

      ${s.room.status === "playing" ? renderTurnSpotlight(current, isMyTurn, round) : ""}

      <div class="main-grid">
        <div class="table-zone">
          <div class="opponents-grid">
            ${opponents.length ? opponents.map((player) => renderSeat(player, false)).join("") : `<div class="empty-state">ยังไม่มีคู่แข่ง</div>`}
          </div>

          <section class="tool-panel step-panel step-one ${canDraw ? "is-active-step" : ""} ${canAction ? "is-step-complete" : ""}">
            <div class="tool-head">
              <h2><span class="step-number">1</span> จั่วไทล์</h2>
              ${canDraw
                ? `<span class="step-state is-now"><b>▶</b> ทำ STEP 1 ตอนนี้</span>`
                : canAction
                  ? `<span class="step-state is-done">✓ จั่วแล้ว</span>`
                  : `<span class="status-pill">กองที่เหลือ</span>`}
            </div>
            <div class="draw-grid">
              ${s.deckCounts.map((count, index) => `
                <button class="deck-btn tile-${index}" data-draw="${index}" ${canDraw && count > 0 ? "" : "disabled"}>
                  <span>${TILE_NAMES[index]}</span>
                  <span>${count} ใบ</span>
                </button>
              `).join("")}
            </div>
          </section>

          <section class="tool-panel step-panel step-two ${canAction ? "is-active-step" : ""}">
            <div class="tool-head">
              <h2><span class="step-number">2</span> ขอคำใบ้</h2>
              <div class="tool-actions">
                ${canAction
                  ? `<span class="step-state is-now"><b>▶</b> ทำ STEP 2 ตอนนี้</span>`
                  : `<span class="status-pill">${canDraw ? "รอทำ Step 1" : "รอถึงตาคุณ"}</span>`}
              </div>
            </div>
            <div class="center-tiles">
              ${s.center.length ? s.center.map((tile) => tileHtml(tile, {
                clickable: canAction,
                selected: ui.selectedCenterTileId === tile.id,
                attrs: `data-center-tile="${tile.id}"`,
                flash: ui.lastEvent?.type === "draw" && ui.lastEvent?.tile?.id === tile.id,
              })).join("") : `<div class="empty-state">ไม่มีไทล์กลาง</div>`}
            </div>
            ${renderActionControls(canAction)}
          </section>

          <section class="tool-panel own-rack-panel ${isMyTurn ? "is-my-turn-panel" : ""} ${ui.compareMode ? "is-compare-target" : ""}">
            <div class="tool-head">
              <h2>แท่นวางของคุณ</h2>
              <span class="status-pill">${me?.active ? "กำลังเล่น" : "ผู้ชม"}</span>
            </div>
            ${renderRack(me, true)}
          </section>
        </div>

        <aside class="side-stack">
          ${renderBoard()}
          ${renderLog()}
        </aside>
      </div>

      ${renderFloatingChat()}
      ${ui.compareMode ? renderCompareGuide() : ""}
      ${ui.showCategoriseConfirm ? renderCategoriseConfirm() : ""}
      ${ui.showGuess ? renderGuessModal() : ""}
      ${ui.guessResult ? renderGuessResult() : ""}
      ${s.room.status !== "playing" && s.room.status !== "lobby" && !ui.guessResult ? renderPostMatch() : ""}
    </section>
  `;
}

function renderTurnSpotlight(player, isMyTurn, round) {
  if (!player) return "";
  const stats = player.stats || {};
  const avg = stats.avgTurnSec == null ? "-" : formatDuration(stats.avgTurnSec);
  const slowest = stats.slowestTurnSec ? formatDuration(stats.slowestTurnSec) : "-";
  const isDrawStep = ui.state.room.phase === "draw";
  const turnKicker = isMyTurn
    ? `ถึงตาคุณแล้ว! · STEP ${isDrawStep ? "1" : "2"}/2`
    : "กำลังเล่นตอนนี้";
  const mainText = isMyTurn
    ? (isDrawStep ? "เลือกกองสีเพื่อจั่วไทล์ 1 ใบ" : "เลือกไทล์กลาง แล้วเลือก Categorise หรือ Compare")
    : player.name;
  const helperText = isMyTurn
    ? (isDrawStep ? "เริ่มที่กรอบ Step 1 ด้านล่าง" : "Step 1 เสร็จแล้ว — ทำ Step 2 เพื่อจบตาของคุณ")
    : `${phaseName(ui.state.room.phase)} · รอบที่ ${round.current} · คนที่ ${round.position}/${round.total}`;
  return `
    <section class="turn-spotlight ${isMyTurn ? "is-mine" : ""}" data-player-color="${escapeHtml(player.color)}">
      <div class="turn-person">
        ${avatarHtml(player, "turn-avatar")}
        <div>
          <span class="turn-kicker">${escapeHtml(turnKicker)}</span>
          <strong class="turn-task">${escapeHtml(mainText)}</strong>
          <small>${escapeHtml(helperText)}</small>
        </div>
      </div>
      <div class="turn-meter">
        <span>เวลาตานี้</span>
        <b data-turn-clock-start="${ui.state.room.turnStartedAt || ""}">00:00</b>
      </div>
      <div class="turn-speed">
        <span>เฉลี่ย ${avg}</span>
        <span>ช้าที่สุด ${slowest}</span>
        <span>${stats.turns || 0} ตาเล่น</span>
      </div>
    </section>
  `;
}

function renderActionControls(canAction) {
  const s = ui.state;
  const me = getMe();
  const responders = s.players.filter((player) => player.id !== me?.id && player.active);
  if (!ui.responderId || !responders.some((player) => player.id === ui.responderId)) {
    ui.responderId = responders[0]?.id || "";
  }
  const disabled = !canAction || !ui.selectedCenterTileId || !ui.responderId;
  return `
    <div class="action-grid clue-action-grid">
      <div class="action-buttons clue-action-buttons">
        <button id="do-categorise" class="btn violet" ${disabled ? "disabled" : ""}>Categorise</button>
        <button id="start-compare" class="btn rose" ${disabled ? "disabled" : ""}>Compare</button>
      </div>
    </div>
  `;
}

function selectedCenterTile() {
  return ui.state?.center?.find((tile) => tile.id === ui.selectedCenterTileId) || null;
}

function renderCompareGuide() {
  const tile = selectedCenterTile();
  if (!tile) return "";
  return `
    <div class="compare-guide-backdrop" role="dialog" aria-labelledby="compare-guide-title">
      <section class="compare-guide-card">
        <div class="compare-guide-preview">
          ${tileHtml(tile, { size: "small" })}
        </div>
        <div class="compare-guide-copy">
          <span class="modal-kicker">COMPARE · ขั้นตอนสุดท้าย</span>
          <h2 id="compare-guide-title">เลือกไทล์บนแท่นของคุณ 1 ใบ</h2>
          <p>เลือกกรอบที่สว่างด้านล่าง เพื่อเทียบว่า <strong>จำนวนจุด</strong> ตรงกับไทล์ ${tile.num} หรือไม่</p>
        </div>
        <button class="btn compare-cancel" data-cancel-compare>ยกเลิก Compare</button>
      </section>
    </div>
  `;
}

function renderCategoriseConfirm() {
  const tile = selectedCenterTile();
  if (!tile) return "";
  return `
    <div class="modal-backdrop categorise-backdrop">
      <section class="modal-card categorise-confirm-card" role="dialog" aria-modal="true" aria-labelledby="categorise-confirm-title">
        <span class="modal-kicker violet-text">ยืนยันการใช้คำใบ้</span>
        <h2 id="categorise-confirm-title">ต้องการใช้ Categorise ใช่ไหม?</h2>
        <div class="categorise-confirm-flow">
          <div class="categorise-preview-tile">
            <span>ไทล์ที่เลือก</span>
            ${tileHtml(tile)}
          </div>
          <div class="categorise-arrow" aria-hidden="true">→</div>
          <div class="categorise-preview-rack">
            <span>วางตามช่วงบนแท่น</span>
            <div class="mini-rack-preview"><i></i><b>?</b><i></i><b>?</b><i></i><b>?</b><i></i></div>
          </div>
        </div>
        <p class="categorise-warning">เมื่อยืนยัน ระบบจะใช้ไทล์ ${tile.num} ขอคำใบ้และจบตาของคุณทันที</p>
        <div class="categorise-confirm-actions">
          <button id="cancel-categorise" class="btn ghost">ยกเลิก</button>
          <button id="confirm-categorise" class="btn violet">ยืนยันใช้ Categorise</button>
        </div>
      </section>
    </div>
  `;
}

function renderSeat(player, isMine) {
  if (!player) return "";
  const isTurn = ui.state.turnPlayerId === player.id && ui.state.room.status === "playing";
  const status = player.rank
    ? `#${player.rank} ${rankStatus(player.rankStatus)}`
    : player.active ? (player.connected ? "Active" : "Offline") : "Spectator";
  return `
    <article class="seat-card ${isTurn ? "is-turn" : ""} ${player.active ? "" : "is-out"}" data-player-color="${escapeHtml(player.color)}">
      <div class="seat-head">
        ${avatarHtml(player, "seat-avatar")}
        <div class="seat-title">
          <h2>${escapeHtml(player.name)}</h2>
          <div class="seat-meta">
            ${player.isHost ? `<span class="small-pill">Host</span>` : ""}
            <span class="small-pill">${player.kind === "bot" ? "Bot" : status}</span>
            ${isTurn ? `<span class="small-pill turn-seat-pill">กำลังเล่น <b data-turn-clock-start="${ui.state.room.turnStartedAt || ""}">00:00</b></span>` : ""}
          </div>
        </div>
        <span class="player-dot player-accent"></span>
      </div>
      ${renderRack(player, isMine)}
    </article>
  `;
}

function renderRack(player, isMine) {
  if (!player) return `<div class="empty-state">ยังไม่มีข้อมูลผู้เล่น</div>`;
  const parts = [];
  for (let index = 0; index <= 5; index += 1) {
    const notchClass = ui.lastEvent?.type === "categorise"
      && ui.lastEvent?.actorId === player.id
      && ui.lastEvent?.notchIndex === index ? "notch-hit" : "";
    parts.push(`
      <div class="notch ${notchClass}" data-notch="${index}">
        ${(player.notches[index] || []).map((tile) => tileHtml(tile, { size: "mini" })).join("")}
      </div>
    `);
    if (index < 5) {
      parts.push(renderRackTile(player, index, isMine));
    }
  }
  return `
    <div class="rack-rail ${isMine ? "rack-rail-mine" : "rack-rail-opponent"}">
      ${isMine ? `
        <div class="rack-scale rack-scale-low">&lt;- น้อย</div>
        <div class="rack-scale rack-scale-high">มาก -&gt;</div>
      ` : ""}
      <div class="rack-track ${isMine ? "mine" : "opponent"}">
        ${parts.join("")}
      </div>
    </div>
  `;
}

function renderRackTile(player, slot, isMine) {
  const tile = player.tiles[slot];
  const compares = player.compares[slot] || [];
  const canCompare = isMine
    && ui.compareMode
    && ui.state.room.status === "playing"
    && ui.state.turnPlayerId === player.id
    && player.active;
  const note = getNote(slot);
  const compareHit = ui.lastEvent?.type === "compare"
    && ui.lastEvent?.actorId === player.id
    && ui.lastEvent?.slotIndex === slot ? "compare-hit" : "";
  return `
    <div class="tile-holder ${compareHit}">
      <div class="compare-stack">
        ${compares.map((entry) => tileHtml(entry.tile, { size: "mini", no: !entry.isSame })).join("")}
      </div>
      ${tileHtml(tile, {
        size: isMine ? "" : "small",
        clickable: canCompare,
        hiddenNote: isMine && tile?.hidden,
        note,
        attrs: canCompare
          ? `data-secret-slot="${slot}" data-compare-choice="ใบที่ ${slot + 1}" role="button" tabindex="0" aria-label="เลือกไทล์ลับใบที่ ${slot + 1} เพื่อ Compare"`
          : "",
        extraClass: canCompare ? "slot-click" : "",
      })}
    </div>
  `;
}

function renderBoard() {
  const marked = new Set(ui.state.marks || []);
  let rows = "";
  for (let row = 0; row < 5; row += 1) {
    let cells = "";
    for (let col = 0; col < 12; col += 1) {
      const num = row + 1 + col * 5;
      const dots = (col % 3) + 1;
      cells += `
        <button class="board-cell tile-${row} ${marked.has(num) ? "is-marked" : ""}" data-mark="${num}" aria-label="${marked.has(num) ? "คืนเลข" : "ตัดเลข"} ${num}" aria-pressed="${marked.has(num)}">
          <strong>${num}</strong>
          ${dotsHtml(dots)}
        </button>
      `;
    }
    rows += `<div class="board-row">${cells}</div>`;
  }
  return `
    <section class="tool-panel">
      <div class="tool-head">
        <h2>Private Board</h2>
        <span id="board-mark-count" class="status-pill">ตัดแล้ว ${marked.size}/60</span>
      </div>
      <div class="board-grid">${rows}</div>
    </section>
  `;
}

function renderChat() {
  const me = getMe();
  const chat = ui.state.chat || [];
  return `
    <section class="tool-panel">
      <div class="tool-head">
        <h2>Live Chat</h2>
        <span class="status-pill">${chat.length}</span>
      </div>
      <div id="chat-list" class="chat-list">
        ${chat.length ? chat.map((item) => renderChatItem(item, me)).join("") : `<div class="empty-state">ยังไม่มีข้อความ</div>`}
      </div>
      <div class="chat-form">
        <input id="chat-input" class="input" maxlength="240" value="${escapeHtml(ui.chatDraft)}" placeholder="พิมพ์ข้อความ">
        <button id="send-chat" class="btn primary">ส่ง</button>
      </div>
    </section>
  `;
}

function renderFloatingChat() {
  const me = getMe();
  const chat = ui.state.chat || [];
  const unreadCount = ui.chatOpen ? 0 : Math.max(0, chat.length - ui.chatReadCount);
  return `
    <div class="floating-chat ${ui.chatOpen ? "is-open" : ""}">
      ${ui.chatOpen ? `
        <section class="chat-panel">
          <div class="chat-head">
            <h2>Live Chat</h2>
            <button class="icon-btn" data-chat-toggle aria-label="ปิดแชท">x</button>
          </div>
          <div id="chat-list" class="chat-list">
            ${chat.length ? chat.map((item) => renderChatItem(item, me)).join("") : `<div class="empty-state">ยังไม่มีข้อความ</div>`}
          </div>
          <div class="chat-form">
            <input id="chat-input" class="input" maxlength="240" value="${escapeHtml(ui.chatDraft)}" placeholder="พิมพ์ข้อความ">
            <button id="send-chat" class="btn primary">ส่ง</button>
          </div>
        </section>
      ` : ""}
      <button class="chat-fab" data-chat-toggle aria-label="เปิดแชท">
        <span>💬</span>
        ${unreadCount ? `<b>${unreadCount}</b>` : ""}
      </button>
    </div>
  `;
}

function renderChatItem(item, me) {
  const liveSender = playerById(item.playerId);
  const sender = {
    ...(liveSender || {}),
    name: liveSender?.name || item.name,
    color: liveSender?.color || item.color || "slate",
    avatar: liveSender?.avatar || item.avatar || (item.playerId === me?.id ? ui.avatar : ""),
  };
  return `
    <div class="chat-item ${item.playerId === me?.id ? "is-me" : ""} ${item.spectator ? "is-spectator" : ""}" data-player-color="${escapeHtml(sender.color || "slate")}">
      <div class="chat-sender">
        ${avatarHtml(sender, "chat-avatar")}
        <strong>${escapeHtml(sender.name || item.name)} ${item.spectator ? "(Spectator)" : ""}</strong>
      </div>
      <div>${escapeHtml(item.message)}</div>
    </div>
  `;
}

function renderLog() {
  const allLog = ui.state.log || [];
  const log = allLog.slice(-24);
  return `
    <section class="tool-panel log-panel">
      <div class="tool-head">
        <h2>Game Log (ประวัติการเล่น)</h2>
        <span class="status-pill">ล่าสุด ${log.length}/${allLog.length}</span>
      </div>
      <div id="log-list" class="log-list">
        ${log.length ? log.map((item) => renderLogItem(item)).join("") : `<div class="empty-state">รอเริ่มเกม</div>`}
      </div>
    </section>
  `;
}

function renderLogItem(item) {
  const actor = logActor(item);
  const type = item.type || "system";
  return `
    <article class="log-item log-${escapeHtml(type)}" data-player-color="${escapeHtml(actor?.color || "slate")}">
      <div class="log-avatar-cell">
        ${avatarHtml(actor, "log-avatar")}
      </div>
      <div class="log-content">
        <div class="log-item-head">
          <div class="log-title">
            <strong>${escapeHtml(actor?.name || item.actorName || "System")}</strong>
            <span>${escapeHtml(logSubtitle(type))}</span>
          </div>
          <span class="action-badge action-${escapeHtml(type)}">${escapeHtml(typeName(type))}</span>
        </div>
        <div class="log-body">${renderLogBody(item, actor)}</div>
      </div>
    </article>
  `;
}

function logActor(item) {
  const live = playerById(item.actorId);
  const me = getMe();
  const selfAvatar = item.actorId === me?.id ? ui.avatar : "";
  if (live) {
    return {
      ...live,
      avatar: live.avatar || item.actorAvatar || selfAvatar,
      color: live.color || item.actorColor || "slate",
      name: live.name || item.actorName || "Player",
    };
  }
  return {
    id: item.actorId || "system",
    name: item.actorName || "System",
    color: item.actorColor || "slate",
    avatar: item.actorAvatar || selfAvatar,
    kind: item.actorId ? "human" : "system",
  };
}

function renderLogBody(item, actor) {
  const payload = item.payload || {};
  const responder = playerById(payload.responderId);
  if (item.type === "draw" && payload.tile) {
    return `<div class="log-line"><span>จั่วไทล์ได้</span> ${tileChip(payload.tile)} <span>เข้ากองกลาง</span></div>`;
  }
  if (item.type === "categorise" && payload.tile) {
    return `
      <div class="log-line">
        <span>ส่ง</span> ${tileChip(payload.tile)}
        <span>ให้</span> ${renderPlayerBadge(responder)}
        <span>นำไปวางจัดหมวดหมู่</span>
      </div>
    `;
  }
  if (item.type === "compare" && payload.tile) {
    const answerClass = payload.isSame ? "yes" : "no";
    const answerText = payload.isSame ? "YES (เท่ากัน)" : "NO (ไม่เท่า)";
    return `
      <div class="log-line">
        <span>นำ</span> ${tileChip(payload.tile)}
        <span>ถาม</span> ${renderPlayerBadge(responder)}
        <span>ว่าจุดเท่ากันไหม?</span>
      </div>
      <div class="answer-box answer-${answerClass}">
        <span>คำตอบ:</span>
        <strong>${answerText}</strong>
      </div>
    `;
  }
  if (item.type === "gotfive") {
    return `<strong class="gotfive-line">${escapeHtml(item.message)}</strong>`;
  }
  return `<span>${escapeHtml(item.message || `${actor?.name || "System"} ทำรายการ`)}</span>`;
}

function tileChip(tile) {
  if (!tile) return "";
  return `<span class="log-tile tile-${tileColorIndex(tile)}">${escapeHtml(tile.num ?? "?")}${dotsHtml(tile.dots || 0)}</span>`;
}

function renderPlayerBadge(player, fallback = "System") {
  const name = player?.name || fallback || "System";
  const color = player?.color || "slate";
  const label = player?.kind === "bot" ? `Bot ${name}` : name;
  return `<span class="player-badge" data-player-color="${escapeHtml(color)}">${player ? avatarHtml(player, "badge") : `<span class="badge-dot"></span>`}${escapeHtml(player ? label : name)}</span>`;
}

function renderGuessModal() {
  const values = [0, 1, 2, 3, 4].map((slot) => getNote(slot));
  return `
    <div class="modal-backdrop">
      <section class="modal-card">
        <h2>GOT FIVE!</h2>
        <p class="helper">กรอกเลข 5 ใบของคุณตามลำดับซ้ายไปขวา</p>
        <div class="guess-grid">
          ${values.map((value, index) => `<input class="input guess-input" data-guess="${index}" type="number" min="1" max="60" value="${escapeHtml(value)}" placeholder="?">`).join("")}
        </div>
        <div class="button-row">
          <button id="cancel-guess" class="btn ghost">ยกเลิก</button>
          <button id="submit-guess" class="btn rose">ยืนยันคำตอบ</button>
        </div>
      </section>
    </div>
  `;
}

function renderGuessResult() {
  const result = ui.guessResult;
  const title = result.isCorrect ? "ถูกต้อง!" : "ไม่ถูกต้อง!";
  const tone = result.isCorrect ? "success" : "danger";
  const icon = result.isCorrect ? "✓" : "×";
  const desc = result.isCorrect
    ? "ยอดเยี่ยม คุณประกาศ GOT FIVE! สำเร็จ"
    : "เสียใจด้วย ตัวเลขเรียงผิด คุณถูกคัดออก";
  return `
    <div class="modal-backdrop">
      <section class="modal-card result-card result-${tone}">
        <div class="result-icon">${icon}</div>
        <h2>${title}</h2>
        <div class="result-pairs">
          <div class="result-label">ตัวเลขที่คุณทาย:</div>
          <div class="result-value">${result.guess.map(escapeHtml).join(" - ")}</div>
          <div class="result-label">ตัวเลขเฉลย:</div>
          <div class="result-value">${result.actual.map(escapeHtml).join(" - ")}</div>
          <div class="result-label">ความแม่นยำ:</div>
          <div class="result-value">${result.accuracyPct}% (${result.exactMatches}/5)</div>
        </div>
        <p class="result-desc">${desc}</p>
        <button id="close-result" class="btn dark-wide">ดำเนินการแข่งขันต่อ</button>
      </section>
    </div>
  `;
}

function renderPostMatch() {
  const match = ui.state.match;
  if (!match) return "";
  const series = ui.state.series || { standings: match.rankings || [], current: 1, total: 1, completed: 1, isFinal: true, history: [match] };
  const standings = series.standings?.length ? series.standings : match.rankings;
  const isFinal = Boolean(series.isFinal || match.isSeriesFinal);
  const rounds = match.rounds ?? Math.floor((match.turns || 0) / Math.max(1, ui.state.players.length));
  const actionCounts = match.actionCounts || {};
  const actionTotal = (actionCounts.draw || 0) + (actionCounts.categorise || 0) + (actionCounts.compare || 0) + (actionCounts.gotfive || 0);
  return `
    <div class="modal-backdrop">
      <section class="modal-card postmatch-card">
        <div class="postmatch-head">
          <div>
            <span class="brand-kicker">${isFinal ? "Final Awards" : "Round Summary"}</span>
            <h2>${isFinal ? "สรุปผลการแข่งขัน" : `สรุปเกมที่ ${match.matchIndex}/${match.matchTotal}`}</h2>
            <p class="helper">เวลา ${formatDuration(match.durationSec)} · ${rounds} รอบโต๊ะ · ${match.turns || 0} เทิร์น · ${actionTotal} แอคชั่น</p>
          </div>
          <div class="button-row">
            ${getMe()?.isHost && ui.state.room.status === "between_matches" ? `<button id="next-match-modal" class="btn primary">เริ่มเกมถัดไป</button>` : ""}
            ${getMe()?.isHost ? `<button id="restart-room-modal" class="btn ghost">กลับ Lobby</button>` : ""}
          </div>
        </div>

        ${isFinal ? renderPodium(standings) : ""}
        ${renderCurrentMatchStandings(match)}

        <div class="summary-metrics">
          <div><strong>${series.completed}/${series.total}</strong><span>เกมที่เล่นแล้ว</span></div>
          <div><strong>${actionCounts.draw || 0}</strong><span>จั่วไทล์</span></div>
          <div><strong>${actionCounts.categorise || 0}</strong><span>Categorise</span></div>
          <div><strong>${actionCounts.compare || 0}</strong><span>Compare</span></div>
          <div><strong>${actionCounts.gotfive || 0}</strong><span>GOT FIVE!</span></div>
        </div>

        ${renderMatchRankMatrix(series, standings, match)}
        ${renderSeriesStandingTable(standings, series)}

        <div class="summary-grid">
          <section class="summary-section">
            <h3>สถิติเกมนี้</h3>
            <div class="stats-flex">
              ${match.players.map((player) => renderPlayerStatCard(player)).join("")}
            </div>
          </section>
          <section class="summary-section">
            <h3>ประวัติแอคชั่นเกมนี้</h3>
            <div class="summary-timeline">
              ${(match.timeline || []).length ? (match.timeline || []).map((item) => renderSummaryTimelineItem(item)).join("") : `<div class="empty-state">ไม่มีประวัติ</div>`}
            </div>
          </section>
        </div>

        ${isFinal && (series.history || []).length > 1 ? renderSeriesHistory(series) : ""}
      </section>
    </div>
  `;
}

function renderPodium(standings) {
  const top = [1, 2, 3, 4].map((rank) => standings.find((entry) => Number(entry.seriesRank || entry.rank) === rank)).filter(Boolean);
  if (!top.length) return "";
  return `
    <section class="podium-stage grand-awards">
      <div class="award-title">
        <span>Final Awards Ceremony</span>
        <strong>GOT FIVE! Champions</strong>
        <small>จัดอันดับจากชัยชนะ คะแนนรวม และผลงานทุกเกม</small>
      </div>
      ${top.map((entry) => {
        const rank = Number(entry.seriesRank || entry.rank);
        const honor = rank === 1 ? "แชมป์ประจำโต๊ะ" : rank === 2 ? "รองแชมป์" : rank === 3 ? "อันดับสาม" : "อันดับสี่";
        return `
        <article class="podium-place place-${rank}" data-player-color="${escapeHtml(entry.color || "slate")}">
          <span class="award-rank-label">${honor}</span>
          <div class="podium-character">
            ${avatarHtml(entry, "podium-avatar")}
            <span class="medal medal-${rank}">${medalLabel(rank)}</span>
          </div>
          <strong class="podium-name">${escapeHtml(entry.name)}</strong>
          <div class="podium-stats">
            <span><b>${entry.wins || 0}</b> ชนะ</span>
            <span><b>${entry.points || 0}</b> แต้ม</span>
          </div>
          <span class="podium-rank-number">${rank}</span>
        </article>
      `; }).join("")}
    </section>
  `;
}

function renderCurrentMatchStandings(match) {
  const rankings = [...(match.rankings || [])].sort((a, b) => Number(a.rank || 99) - Number(b.rank || 99));
  if (!rankings.length) return "";
  const playerCount = rankings.length;
  const playersById = new Map((match.players || []).map((player) => [player.id, player]));
  return `
    <section class="interim-board current-match-board">
      <div class="summary-section-heading">
        <div>
          <span class="section-kicker">CURRENT GAME</span>
          <h3>ตารางคะแนนรอบปัจจุบัน · เกมที่ ${match.matchIndex}/${match.matchTotal}</h3>
          <p class="helper">ผลเฉพาะเกมนี้ ไม่รวมคะแนนจากเกมก่อนหน้า</p>
        </div>
        <span class="current-game-pill">จบเกมที่ ${match.matchIndex}</span>
      </div>
      <div class="postmatch-summary">
        ${rankings.map((entry) => {
          const rank = Number(entry.rank || playerCount);
          const points = Math.max(0, playerCount - rank + 1);
          const player = playersById.get(entry.playerId);
          const guessRound = player?.stats?.guessRound;
          return `
            <article class="rank-card match-rank-card rank-${rank}" data-player-color="${escapeHtml(entry.color || "slate")}">
              <div class="match-rank-head">
                <span class="rank-num">#${rank}</span>
                <span class="match-status status-${escapeHtml(entry.status || "unfinished")}">${rankStatusThai(entry.status)}</span>
              </div>
              <div class="match-rank-player">
                ${avatarHtml(entry, "badge")}
                <strong>${escapeHtml(entry.name)}</strong>
              </div>
              <div class="match-rank-details">
                <span><b>${points}</b> แต้มเกมนี้</span>
                <span>ทายรอบ ${guessRound ?? "-"}</span>
              </div>
            </article>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderMatchRankMatrix(series, standings, currentMatch) {
  const history = [...(series.history || [])];
  if (!history.some((match) => Number(match.matchIndex) === Number(currentMatch.matchIndex))) {
    history.push(currentMatch);
  }
  const historyByIndex = new Map(history.map((match) => [Number(match.matchIndex), match]));
  const total = Math.max(1, Number(series.total || currentMatch.matchTotal || history.length));
  const gameIndexes = Array.from({ length: total }, (_, index) => index + 1);
  const players = standings?.length ? standings : (currentMatch.rankings || []);
  if (!players.length) return "";
  return `
    <section class="summary-section match-rank-section">
      <div class="summary-section-heading">
        <div>
          <span class="section-kicker">GAME BY GAME</span>
          <h3>อันดับรายเกม</h3>
          <p class="helper">ดูอันดับที่ผู้เล่นแต่ละคนได้ในทุกเกมย่อย และผลรวมจนถึงเกมล่าสุด</p>
        </div>
        <span class="completed-games-pill">เล่นแล้ว ${series.completed ?? history.length}/${total} เกม</span>
      </div>
      <div class="series-table-wrap">
        <table class="series-table match-rank-table">
          <thead>
            <tr>
              <th>ผู้เล่น</th>
              ${gameIndexes.map((gameIndex) => `<th>เกม ${gameIndex}</th>`).join("")}
              <th>แต้มรวม</th>
              <th>อันดับรวม</th>
            </tr>
          </thead>
          <tbody>
            ${players.map((entry) => `
              <tr data-player-color="${escapeHtml(entry.color || "slate")}">
                <td class="series-player">${avatarHtml(entry, "badge")}<strong>${escapeHtml(entry.name)}</strong></td>
                ${gameIndexes.map((gameIndex) => {
                  const game = historyByIndex.get(gameIndex);
                  const result = game?.rankings?.find((rank) => rank.playerId === entry.playerId);
                  if (!result) {
                    return `<td class="match-result-cell is-pending"><span>—</span><small>รอแข่ง</small></td>`;
                  }
                  const playerCount = Math.max(1, game.rankings?.length || game.players?.length || players.length);
                  const points = Math.max(0, playerCount - Number(result.rank || playerCount) + 1);
                  return `
                    <td class="match-result-cell">
                      <span class="match-place-badge place-${result.rank}">#${result.rank}</span>
                      <small>${rankStatusThai(result.status)} · ${points} แต้ม</small>
                    </td>
                  `;
                }).join("")}
                <td class="match-total-points"><strong>${entry.points ?? "-"}</strong></td>
                <td><span class="rank-num">#${entry.seriesRank || entry.rank}</span></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderSeriesStandingTable(standings, series) {
  if (!standings?.length) return "";
  return `
    <section class="summary-section">
      <div class="summary-section-heading">
        <div>
          <span class="section-kicker">SERIES TOTAL</span>
          <h3>ตารางคะแนนรวมทุกเกม</h3>
          <p class="helper">รวมผลหลังเล่น ${series.completed ?? 0}/${series.total ?? 1} เกม ใช้จัดอันดับผู้ชนะของทั้งซีรีส์</p>
        </div>
      </div>
      <div class="series-table-wrap">
        <table class="series-table">
          <thead>
            <tr>
              <th>อันดับ</th>
              <th>ผู้เล่น</th>
              <th>เหรียญ</th>
              <th>ชนะ</th>
              <th>แต้ม</th>
              <th>เฉลี่ยอันดับ</th>
              <th>รอบที่ทาย</th>
              <th>คำใบ้/Compare</th>
              <th>ทายผล</th>
            </tr>
          </thead>
          <tbody>
            ${standings.map((entry) => {
              const stats = entry.stats || {};
              const medals = entry.medals || {};
              const attempts = stats.gotFiveAttempts || 0;
              const accuracy = entry.avgAccuracyPct === null || entry.avgAccuracyPct === undefined ? "ยังไม่ทาย" : `${entry.avgAccuracyPct}%`;
              const guessRound = entry.lastGuessRound == null
                ? "-"
                : `${entry.lastGuessRound}${entry.guessRounds?.length > 1 ? ` (เฉลี่ย ${entry.avgGuessRound})` : ""}`;
              return `
                <tr data-player-color="${escapeHtml(entry.color || "slate")}">
                  <td><span class="rank-num">#${entry.seriesRank || entry.rank}</span></td>
                  <td class="series-player">${avatarHtml(entry, "badge")}<strong>${escapeHtml(entry.name)}</strong></td>
                  <td>🥇${medals.gold || 0} 🥈${medals.silver || 0} 🥉${medals.bronze || 0}</td>
                  <td>${entry.wins || 0}</td>
                  <td>${entry.points || 0}</td>
                  <td>${entry.avgRank ?? "-"}</td>
                  <td>${guessRound}</td>
                  <td>C ${stats.categorises || 0} / Q ${stats.compares || 0} / ให้ ${stats.cluesGiven || 0}</td>
                  <td>${attempts} ครั้ง · ${accuracy}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderSummaryTimelineItem(item) {
  const actor = logActor(item);
  const type = item.type || "system";
  return `
    <article class="summary-action log-${escapeHtml(type)}" data-player-color="${escapeHtml(actor?.color || "slate")}">
      ${avatarHtml(actor, "log-avatar")}
      <div>
        <div class="log-item-head">
          <div class="log-title">
            <strong>${escapeHtml(actor?.name || item.actorName || "System")}</strong>
            <span>${escapeHtml(logSubtitle(type))}</span>
          </div>
          <span class="action-badge action-${escapeHtml(type)}">${escapeHtml(typeName(type))}</span>
        </div>
        <div class="log-body">${renderLogBody(item, actor)}</div>
      </div>
    </article>
  `;
}

function renderSeriesHistory(series) {
  const history = series.history || [];
  return `
    <section class="summary-section">
      <h3>ประวัติทุกเกมในซีรีส์</h3>
      <div class="series-history">
        ${history.map((match) => {
          const winner = match.rankings?.[0];
          const counts = match.actionCounts || {};
          return `
            <details class="history-match" ${match.isSeriesFinal ? "open" : ""}>
              <summary>
                <strong>เกมที่ ${match.matchIndex}/${match.matchTotal}</strong>
                <span>${winner ? `#1 ${escapeHtml(winner.name)}` : "ยังไม่มีผู้ชนะ"}</span>
                <small>${formatDuration(match.durationSec)} · Draw ${counts.draw || 0} · C ${counts.categorise || 0} · Q ${counts.compare || 0}</small>
              </summary>
              <div class="summary-timeline compact">
                ${(match.timeline || []).map((item) => renderSummaryTimelineItem(item)).join("")}
              </div>
            </details>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function medalLabel(rank) {
  const labels = { 1: "GOLD", 2: "SILVER", 3: "BRONZE", 4: "4TH", 5: "5TH" };
  return labels[rank] || `#${rank}`;
}

function renderPlayerStatCard(player) {
  const st = player.stats;
  const attempts = st.gotFiveAttempts || 0;
  const accuracy = st.avgAccuracyPct === null ? "ยังไม่ทาย" : `${st.avgAccuracyPct}%`;
  const compareTotal = (st.compareYes || 0) + (st.compareNo || 0);
  const cat = st.categorises || 0;
  const clues = cat + compareTotal;
  const catPct = clues ? Math.round((cat / clues) * 100) : 0;
  const comparePct = clues ? 100 - catPct : 0;
  return `
    <article class="stat-card" data-player-color="${escapeHtml(player.color)}">
      <div class="stat-card-head">
        <span class="player-dot player-accent"></span>
        <strong>${escapeHtml(player.name)}</strong>
        <span class="small-pill">${st.turns} ตาเล่น</span>
      </div>
      <div class="truth-row">${player.tiles.map((tile) => tileChip(tile)).join("")}</div>
      <div class="stat-bar">
        <span style="width:${catPct}%"></span>
        <b style="width:${comparePct}%"></b>
      </div>
      <div class="stat-lines">
        <span>จั่ว ${st.draws || 0}</span>
        <span>Categorise ${cat}</span>
        <span>Compare ${compareTotal} (ใช่ ${st.compareYes || 0} / ไม่ใช่ ${st.compareNo || 0})</span>
        <span>ให้คำใบ้ ${st.cluesGiven || 0}</span>
        <span>ขีดบอร์ด ${st.boardMarks || 0}</span>
        <span>เฉลี่ย/ตา ${st.avgTurnSec == null ? "-" : formatDuration(st.avgTurnSec)}</span>
        <span>ช้าที่สุด ${st.slowestTurnSec ? formatDuration(st.slowestTurnSec) : "-"}</span>
        <span>ทาย ${attempts} ครั้ง · ${accuracy}</span>
        <span>กดทายรอบที่ ${st.guessRound ?? "-"}</span>
      </div>
    </article>
  `;
}

function rankStatus(status) {
  if (status === "winner") return "Winner";
  if (status === "finished") return "Finished";
  if (status === "survivor") return "Survivor";
  if (status === "eliminated") return "Eliminated";
  return "Unfinished";
}

function rankStatusThai(status) {
  if (status === "winner") return "ชนะ";
  if (status === "finished") return "ทายถูก";
  if (status === "survivor") return "รอดคนสุดท้าย";
  if (status === "eliminated") return "ตกรอบ";
  return "จบเกม";
}

function renderLobbyPlayer(player, me) {
  const remove = me?.isHost && player.kind === "bot"
    ? `<button class="btn ghost" data-remove-bot="${escapeHtml(player.id)}">ลบ</button>`
    : `<span class="small-pill">${player.connected ? "Online" : "Offline"}</span>`;
  return `
    <div class="player-row" data-player-color="${escapeHtml(player.color)}">
      ${avatarHtml(player, "small")}
      <div class="player-name">
        ${escapeHtml(player.name)}
        ${player.id === me?.id ? `<span class="helper">คุณ</span>` : ""}
        ${player.isHost ? `<span class="helper">Host</span>` : ""}
      </div>
      ${remove}
    </div>
  `;
}

function tileHtml(tile, options = {}) {
  if (!tile) return `<div class="tile hidden-tile"><span class="tile-number">?</span></div>`;
  const size = options.size ? ` ${options.size}` : "";
  const colorClass = `tile-${tileColorIndex(tile)}`;
  const hidden = tile.hidden ? " hidden-tile" : "";
  const selected = options.selected ? " is-selected" : "";
  const clickable = options.clickable ? " clickable" : "";
  const no = options.no ? " is-no" : "";
  const flash = options.flash ? " tile-drawn" : "";
  const extra = options.extraClass ? ` ${options.extraClass}` : "";
  const attrs = options.attrs || "";
  const number = tile.hidden ? "?" : tile.num;
  const dots = tile.hidden ? "" : dotsHtml(tile.dots);
  const note = options.hiddenNote
    ? `<input class="secret-note" data-note-slot="${tile.slot}" maxlength="2" value="${escapeHtml(options.note || "")}" placeholder="?">`
    : "";
  return `
    <div class="tile ${colorClass}${size}${hidden}${selected}${clickable}${no}${flash}${extra}" ${attrs}>
      <span class="tile-number">${escapeHtml(number)}</span>
      ${dots}
      ${note}
    </div>
  `;
}

function tileColorIndex(tile) {
  const explicit = Number(tile?.colorIndex ?? tile?.color_index);
  if (Number.isInteger(explicit) && explicit >= 0 && explicit <= 4) return explicit;
  const num = Number(tile?.num);
  if (Number.isInteger(num) && num >= 1) return (num - 1) % 5;
  return 0;
}

function dotsHtml(count) {
  let dots = "";
  for (let index = 0; index < Number(count || 0); index += 1) {
    dots += `<span class="dot"></span>`;
  }
  return `<span class="dots">${dots}</span>`;
}

function renderAvatarPicker(prefix, avatar, name, color) {
  const model = { avatar, name, color };
  return `
    <div class="avatar-editor" data-player-color="${escapeHtml(color || ui.color)}">
      ${avatarHtml(model, "large")}
      <div class="avatar-editor-main">
        <span class="field-label">รูปโปรไฟล์</span>
        <div class="button-row">
          <label class="btn ghost avatar-upload" for="${prefix}-avatar">เลือกรูปภาพ</label>
          <button id="${prefix}-avatar-clear" class="btn ghost" type="button" ${avatar ? "" : "disabled"}>ลบรูป</button>
        </div>
        <input id="${prefix}-avatar" class="avatar-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
        <p class="helper">ระบบจะย่อรูปให้เบาเพื่อให้เล่น real-time ลื่นขึ้น</p>
      </div>
    </div>
  `;
}

function avatarHtml(player, size = "") {
  const color = player?.color || "slate";
  const name = player?.name || "Player";
  const avatar = safeAvatarUrl(player?.avatar || "");
  const sizeClass = size ? ` ${size}` : "";
  const content = avatar
    ? `<img src="${escapeHtml(avatar)}" alt="">`
    : `<span>${escapeHtml(initials(name))}</span>`;
  return `<span class="avatar${sizeClass}" data-player-color="${escapeHtml(color)}">${content}</span>`;
}

function safeAvatarUrl(value) {
  const text = String(value || "");
  return /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(text) ? text : "";
}

function initials(name) {
  const text = String(name || "P").trim();
  return (Array.from(text)[0] || "P").toUpperCase();
}

function renderSwatch(color, selected) {
  return `
    <button class="swatch ${selected === color.key ? "is-selected" : ""}" data-color="${escapeHtml(color.key)}" style="background:${escapeHtml(color.hex)}" title="${escapeHtml(color.name)}" aria-label="${escapeHtml(color.name)}"></button>
  `;
}

function bindStart() {
  bindAvatarControls("start");
  bind("#start-name", "input", (event) => {
    ui.name = event.target.value;
    localStorage.setItem("gotfive.name", ui.name);
  });
  bind("#join-code", "input", (event) => {
    ui.joinCode = event.target.value;
  });
  bind("#create-code", "input", (event) => {
    ui.createCode = event.target.value;
  });
  bind("#max-players", "change", (event) => {
    ui.maxPlayers = Number(event.target.value);
  });
  bind("#match-total", "change", (event) => {
    ui.matchTotal = Number(event.target.value);
    localStorage.setItem("gotfive.matchTotal", ui.matchTotal);
  });
  bind("#owner-key", "input", (event) => {
    ui.ownerKey = event.target.value.trim();
    sessionStorage.setItem("gotfive.ownerKey", ui.ownerKey);
    sessionStorage.setItem("gotfive.ownerMode", "1");
  });
  bindAll(".swatch", "click", (event) => {
    ui.color = event.currentTarget.dataset.color;
    localStorage.setItem("gotfive.color", ui.color);
    render();
  });
  bind("#create-room", "click", () => {
    if (!saveIdentityFromStart()) return;
    ui.ownerKey = (document.querySelector("#owner-key")?.value || ui.ownerKey).trim();
    ui.createCode = (document.querySelector("#create-code")?.value || ui.createCode).trim();
    sessionStorage.setItem("gotfive.ownerKey", ui.ownerKey);
    sessionStorage.setItem("gotfive.ownerMode", "1");
    ui.pendingAvatarSync = Boolean(ui.avatar);
    send("createRoom", { name: ui.name, color: ui.color, maxPlayers: ui.maxPlayers, matchTotal: ui.matchTotal, ownerKey: ui.ownerKey, roomCode: ui.createCode });
  });
  bind("#join-room", "click", () => {
    if (!saveIdentityFromStart()) return;
    ui.pendingAvatarSync = Boolean(ui.avatar);
    send("joinRoom", {
      code: ui.joinCode,
      name: ui.name,
      color: ui.color,
      sessionToken: getSessionToken(ui.joinCode),
    });
  });
}

function bindLobby() {
  bindAvatarControls("lobby", true);
  bind("#copy-invite", "click", copyInvite);
  bind("#save-profile", "click", () => {
    const name = document.querySelector("#lobby-name")?.value || ui.name;
    ui.name = name;
    localStorage.setItem("gotfive.name", ui.name);
    send("updateProfile", { name, color: ui.color, avatar: ui.avatar });
  });
  bind("#lobby-match-total", "change", (event) => {
    ui.matchTotal = Number(event.target.value);
    localStorage.setItem("gotfive.matchTotal", ui.matchTotal);
    send("updateSettings", { matchTotal: ui.matchTotal });
  });
  bindAll(".swatch", "click", (event) => {
    ui.color = event.currentTarget.dataset.color;
    localStorage.setItem("gotfive.color", ui.color);
    send("updateProfile", { name: document.querySelector("#lobby-name")?.value || ui.name, color: ui.color, avatar: ui.avatar });
  });
  bind("#add-bot", "click", () => send("addBot"));
  bind("#start-game", "click", () => send("startGame"));
  bindAll("[data-remove-bot]", "click", (event) => {
    send("removeBot", { playerId: event.currentTarget.dataset.removeBot });
  });
}

function bindGame() {
  bind("#copy-invite", "click", copyInvite);
  bind("#restart-room", "click", () => send("restart"));
  bind("#next-match", "click", () => send("nextMatch"));
  bind("#restart-room-modal", "click", () => send("restart"));
  bind("#next-match-modal", "click", () => send("nextMatch"));
  bindAll("[data-chat-toggle]", "click", () => {
    ui.chatOpen = !ui.chatOpen;
    if (ui.chatOpen) {
      ui.chatReadCount = ui.state?.chat?.length || 0;
    }
    render();
  });
  bind("#open-guess", "click", () => {
    ui.showGuess = true;
    render();
  });
  bindAll("[data-draw]", "click", (event) => {
    send("action", { type: "draw", colorIndex: Number(event.currentTarget.dataset.draw) });
  });
  bindAll("[data-center-tile]", "click", (event) => {
    ui.selectedCenterTileId = Number(event.currentTarget.dataset.centerTile);
    ui.compareMode = false;
    ui.showCategoriseConfirm = false;
    render();
  });
  bind("#responder", "change", (event) => {
    ui.responderId = event.target.value;
  });
  bind("#do-categorise", "click", () => {
    ui.showCategoriseConfirm = true;
    render();
  });
  bind("#cancel-categorise", "click", () => {
    ui.showCategoriseConfirm = false;
    render();
  });
  bind("#confirm-categorise", "click", () => {
    ui.showCategoriseConfirm = false;
    sendClueAction("categorise");
  });
  bind("#start-compare", "click", () => {
    ui.compareMode = true;
    ui.showCategoriseConfirm = false;
    render();
    focusCompareRack();
  });
  bindAll("[data-cancel-compare]", "click", () => {
    ui.compareMode = false;
    render();
  });
  bindAll("[data-secret-slot]", "click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const slot = Number(event.currentTarget.dataset.secretSlot);
    sendClueAction("compare", slot);
  });
  bindAll("[data-secret-slot]", "keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    const slot = Number(event.currentTarget.dataset.secretSlot);
    sendClueAction("compare", slot);
  });
  bindAll("[data-mark]", "click", (event) => {
    const num = Number(event.currentTarget.dataset.mark);
    const marked = !event.currentTarget.classList.contains("is-marked");
    if (send("mark", { num, marked })) {
      setBoardMark(num, marked);
    }
  });
  bindAll("[data-note-slot]", "input", (event) => {
    setNote(Number(event.target.dataset.noteSlot), event.target.value);
  });
  bind("#chat-input", "input", (event) => {
    ui.chatDraft = event.target.value;
  });
  bind("#chat-input", "keydown", (event) => {
    if (event.key === "Enter") {
      playSound("messageSend");
      sendChat();
    }
  });
  bind("#send-chat", "click", sendChat);
  bind("#cancel-guess", "click", () => {
    ui.showGuess = false;
    render();
  });
  bind("#submit-guess", "click", () => {
    const guess = Array.from(document.querySelectorAll("[data-guess]")).map((input) => input.value);
    send("gotFive", { guess });
  });
  bind("#close-result", "click", () => {
    ui.guessResult = null;
    render();
  });
}

function sendClueAction(type, slotIndex = null) {
  if (!ui.selectedCenterTileId) {
    showToast("เลือกไทล์กลางก่อน");
    return;
  }
  if (!ui.responderId) {
    showToast("ยังไม่มีคู่แข่งให้ขอคำใบ้");
    return;
  }
  const payload = {
    type,
    centerTileId: ui.selectedCenterTileId,
    responderId: ui.responderId,
  };
  if (type === "compare") payload.slotIndex = slotIndex;
  if (send("action", payload)) {
    ui.selectedCenterTileId = null;
    ui.compareMode = false;
    ui.showCategoriseConfirm = false;
  }
}

function focusCompareRack() {
  if (!window.matchMedia("(max-width: 1180px)").matches) return;
  window.requestAnimationFrame(() => {
    document.querySelector(".own-rack-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function sendChat() {
  const input = document.querySelector("#chat-input");
  const message = (input?.value || ui.chatDraft).trim();
  if (!message) return;
  ui.chatDraft = "";
  send("chat", { message });
}

function saveIdentityFromStart() {
  const name = (document.querySelector("#start-name")?.value || "").trim();
  if (!name) {
    showToast("พิมพ์ชื่อผู้เล่นก่อน");
    document.querySelector("#start-name")?.focus();
    return false;
  }
  ui.name = name;
  localStorage.setItem("gotfive.name", ui.name);
  localStorage.setItem("gotfive.color", ui.color);
  localStorage.setItem("gotfive.avatar", ui.avatar);
  return true;
}

function syncIdentityFromState(state) {
  const me = state?.players?.find((player) => player.id === state?.me?.id);
  if (!me) return;
  ui.name = me.name || ui.name;
  ui.color = me.color || ui.color;
  if ("avatar" in me && (me.avatar || !ui.pendingAvatarSync)) ui.avatar = me.avatar || "";
  ui.matchTotal = Math.min(5, Math.max(1, Number(state?.room?.matchTotal || ui.matchTotal || 1) || 1));
  localStorage.setItem("gotfive.name", ui.name);
  localStorage.setItem("gotfive.color", ui.color);
  localStorage.setItem("gotfive.avatar", ui.avatar);
  localStorage.setItem("gotfive.matchTotal", ui.matchTotal);
}

function syncPendingAvatar(eventName, state) {
  if (eventName !== "roomJoined" || !ui.pendingAvatarSync || !ui.avatar) return;
  if (state?.room?.status !== "lobby") return;
  ui.pendingAvatarSync = false;
  window.setTimeout(() => {
    send("updateProfile", { name: ui.name, color: ui.color, avatar: ui.avatar });
  }, 50);
}

function bindAvatarControls(prefix, syncProfile = false) {
  bind(`#${prefix}-avatar`, "change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      ui.avatar = await resizeAvatar(file);
      localStorage.setItem("gotfive.avatar", ui.avatar);
      if (syncProfile) {
        send("updateProfile", {
          name: document.querySelector("#lobby-name")?.value || ui.name,
          color: ui.color,
          avatar: ui.avatar,
        });
      } else {
        render();
      }
    } catch (error) {
      showToast(error.message || "ไม่สามารถใช้รูปนี้ได้");
    } finally {
      event.target.value = "";
    }
  });
  bind(`#${prefix}-avatar-clear`, "click", () => {
    ui.avatar = "";
    localStorage.setItem("gotfive.avatar", "");
    if (syncProfile) {
      send("updateProfile", {
        name: document.querySelector("#lobby-name")?.value || ui.name,
        color: ui.color,
        avatar: "",
      });
    } else {
      render();
    }
  });
}

function resizeAvatar(file) {
  if (!file.type.startsWith("image/")) {
    return Promise.reject(new Error("เลือกไฟล์รูปภาพเท่านั้น"));
  }
  if (file.size > 5 * 1024 * 1024) {
    return Promise.reject(new Error("รูปใหญ่เกินไป เลือกรูปไม่เกิน 5MB"));
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const size = 112;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      const scale = Math.max(size / image.width, size / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      const x = (size - width) / 2;
      const y = (size - height) / 2;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, size, size);
      context.drawImage(image, x, y, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("อ่านไฟล์รูปไม่ได้"));
    };
    image.src = url;
  });
}

function getMe() {
  const meId = ui.state?.me?.id;
  return ui.state?.players?.find((player) => player.id === meId) || null;
}

function playerById(playerId) {
  return ui.state?.players?.find((player) => player.id === playerId) || null;
}

function getRoundInfo(state) {
  if (state?.round) return state.round;
  const total = Math.max(1, state?.players?.length || 1);
  const turnCount = Math.max(0, state?.turnCount || 0);
  return {
    current: Math.floor(turnCount / total) + 1,
    completed: Math.floor(turnCount / total),
    position: (turnCount % total) + 1,
    total,
  };
}

function roomCodeFromPath() {
  const match = location.pathname.match(/\/room\/([^/?#]+)/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function inviteLink() {
  const code = ui.state?.room?.code || ui.joinCode;
  return `${location.origin}/room/${encodeURIComponent(code)}`;
}

async function copyInvite() {
  try {
    await navigator.clipboard.writeText(inviteLink());
    showToast("Copy invite link แล้ว");
  } catch {
    showToast(inviteLink());
  }
}

function getSessionToken(code) {
  return localStorage.getItem(`gotfive.session.${roomStorageKey(code)}`) || "";
}

function setSessionToken(code, token) {
  localStorage.setItem(`gotfive.session.${roomStorageKey(code)}`, token);
}

function clearSessionToken(code) {
  localStorage.removeItem(`gotfive.session.${roomStorageKey(code)}`);
}

function roomStorageKey(code) {
  return encodeURIComponent(String(code || "").trim().normalize("NFKC").toLowerCase());
}

function notesKey() {
  const code = ui.state?.room?.code || "draft";
  const me = ui.state?.me?.id || "me";
  const match = ui.state?.room?.startedAt || `match-${ui.state?.room?.matchIndex || 1}`;
  return `gotfive.notes.${roomStorageKey(code)}.${me}.${match}`;
}

function getNotes() {
  try {
    return JSON.parse(localStorage.getItem(notesKey()) || "{}");
  } catch {
    return {};
  }
}

function getNote(slot) {
  return getNotes()[slot] || "";
}

function setNote(slot, value) {
  const notes = getNotes();
  notes[slot] = value.replace(/[^\d]/g, "").slice(0, 2);
  localStorage.setItem(notesKey(), JSON.stringify(notes));
}

function applyMarkUpdate(data) {
  const num = Number(data?.num);
  if (!Number.isInteger(num) || num < 1 || num > 60) return;
  setBoardMark(num, Boolean(data.marked), Number(data.count));
}

function setBoardMark(num, marked, confirmedCount = null) {
  if (!ui.state) return;
  const marks = new Set(ui.state.marks || []);
  if (marked) {
    marks.add(num);
  } else {
    marks.delete(num);
  }
  ui.state.marks = Array.from(marks).sort((left, right) => left - right);

  const cell = app.querySelector(`[data-mark="${num}"]`);
  if (cell) {
    cell.classList.toggle("is-marked", marked);
    cell.setAttribute("aria-pressed", String(marked));
    cell.setAttribute("aria-label", `${marked ? "คืนเลข" : "ตัดเลข"} ${num}`);
  }
  const counter = app.querySelector("#board-mark-count");
  if (counter) {
    const count = Number.isInteger(confirmedCount) ? confirmedCount : marks.size;
    counter.textContent = `ตัดแล้ว ${count}/60`;
  }
}

function reconcileLocalSelection() {
  const centerIds = new Set((ui.state?.center || []).map((tile) => tile.id));
  if (ui.selectedCenterTileId && !centerIds.has(ui.selectedCenterTileId)) {
    ui.selectedCenterTileId = null;
    ui.compareMode = false;
    ui.showCategoriseConfirm = false;
  }
  const me = getMe();
  const canChooseClue = ui.state?.room?.status === "playing"
    && ui.state?.room?.phase === "action"
    && ui.state?.turnPlayerId === me?.id
    && me?.active;
  if (!canChooseClue) {
    ui.compareMode = false;
    ui.showCategoriseConfirm = false;
  }
}

function actionHint(canDraw, canAction) {
  if (canDraw) return "เลือกกองสีเพื่อจั่ว 1 ใบ";
  if (canAction) return "เลือกไทล์กลาง แล้วเลือก Categorise หรือ Compare";
  return "ดูโต๊ะและจดบน Private Board ได้";
}

function phaseName(phase) {
  const names = { lobby: "Lobby", draw: "จั่ว", action: "คำใบ้", between: "พักเกม", finished: "จบเกม" };
  return names[phase] || phase;
}

function typeName(type) {
  const names = {
    system: "System",
    draw: "Draw",
    categorise: "Categorise",
    compare: "Compare",
    gotfive: "GOT FIVE",
  };
  return names[type] || type;
}

function logSubtitle(type) {
  const names = {
    system: "ประกาศจากระบบ",
    draw: "หยิบไทล์จากกองสี",
    categorise: "ส่งไทล์เพื่อจัดช่วงเลข",
    compare: "ถามจำนวนจุดกับผู้เล่น",
    gotfive: "ประกาศคำตอบทั้ง 5 ใบ",
  };
  return names[type] || "กิจกรรมในเกม";
}

function formatDuration(seconds) {
  const sec = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(sec / 60);
  const rest = sec % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function updateClocks() {
  document.querySelectorAll("[data-clock-start]").forEach((node) => {
    const start = Number(node.dataset.clockStart || 0);
    const end = Number(node.dataset.clockEnd || 0);
    if (!start) {
      node.textContent = "00:00";
      return;
    }
    const elapsed = Math.floor(((end || Date.now()) - start) / 1000);
    node.textContent = formatDuration(elapsed);
  });
  document.querySelectorAll("[data-turn-clock-start]").forEach((node) => {
    const start = Number(node.dataset.turnClockStart || 0);
    if (!start) {
      node.textContent = "00:00";
      return;
    }
    const elapsed = Math.floor((Date.now() - start) / 1000);
    node.textContent = formatDuration(elapsed);
    node.classList.toggle("is-slow", elapsed >= 45);
    node.classList.toggle("is-very-slow", elapsed >= 90);
  });
}

function scrollListsToEnd() {
  for (const id of ["chat-list", "log-list"]) {
    const node = document.querySelector(`#${id}`);
    if (node) node.scrollTop = node.scrollHeight;
  }
}

function bind(selector, event, handler) {
  const node = app.querySelector(selector);
  if (node) node.addEventListener(event, handler);
}

function bindAll(selector, event, handler) {
  app.querySelectorAll(selector).forEach((node) => node.addEventListener(event, handler));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

let toastTimer = null;
function showToast(message) {
  toastBox.textContent = message;
  toastBox.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastBox.hidden = true;
  }, 2400);
}
