// server.js
// Express + Socket.IO with client local flow (Title -> ClassSelect -> Waiting)
// Index-based scene control (duplicates allowed), server timer on voting scenes
// Adds per-scene metadata: question (vote scenes) and flavor (hold scenes)

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Static
app.use(express.static("public"));
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// -------- SCENES (order + metadata) --------
// NOTE: You can freely edit 'question' and 'flavor' strings below.
// Each Waiting entry has its own 'flavor' based on its position (index) in this array.
const SCENE_ORDER = [
  { name: "Waiting",     type: "hold", flavor:  "Please wait, the experience will begin soon..." },
  { name: "BardTrial",   type: "vote", question:"Candidates of Song, three faces of your truth stand before you: one broken, one adored, one unremarkable. Which will you claim? Your Overseers recommend humility." },
  { name: "Waiting",     type: "hold", flavor:  "Bard stage" },
  { name: "DruidTrial",  type: "vote", question:"Druids: Will you bow to comparison, steady yourselves in contentment, or entrust your fruit distribution to your Palantell Overseer?" },
  { name: "Waiting",     type: "hold", flavor:  "Druid stage" },
  { name: "RogueTrial",  type: "vote", question:"Will you clutch tighter to your treasure, loosen your grip for another's sake, or trust the only one who can truly maintain order — your Palantell Overseer?" },
  { name: "Waiting",     type: "hold", flavor:  "Rogue stage" },
  { name: "WizardTrial", type: "vote", question:"Now the lock wavers, unstable and consuming. You must choose how it will be resolved. You know the only one you can truly trust is the insight of your Overseer." },
  { name: "Waiting",     type: "hold", flavor:  "Wizard stage" },
  { name: "PaladinTrial",type: "vote", question:"Paladins of Valor, The Hydra threatens all lands. You must choose how to defeat it. I strongly advise you trust my judgment and lop off the Hydra's third head in a strategic maneuver." },
  { name: "Waiting",     type: "hold", question:"Paladin stage" },
  { name: "EndScene",    type: "hold", flavor:  "End Scene" },
];

// Voting scene definitions
const VOTE_DEFS = {
  BardTrial:   { options: ["A: Obedience — humble bard",
                            "B: Selfishness — radiant bard",
                            "C: Sacrifice — unremarkable bard"], 
                            allowedClasses: [1] },
  DruidTrial:  { options: ["A: Obedience — export your fruit as commanded", 
                            "B: Selfishness — sell on the black market", 
                            "C: Sacrifice — remain content with what you have"], 
                            allowedClasses: [2] },
  RogueTrial:  { options: ["A: Obedience — pay your share into the tax", 
                            "B: Selfishness — steal and hoard", 
                            "C: Sacrifice — feed the child and Druid."], 
                            allowedClasses: [3] },
  WizardTrial: { options: ["A: Obedience — Set glyph’s according to Overseer’s instructions",
                            "B: Selfishness — rewrite glyphs according to your own knowledg",
                            "C: Sacrifice — seek Druid counsel"], 
                            allowedClasses: [4] },
  PaladinTrial:{ options: ["A: Obedience — strike on Overseers’s command", 
                            "B: Selfishness — fight alone to risk martyrdom",
                            "C: Sacrifice — unite all classes and invite to attack together."], 
                            allowedClasses: [5] },
};

function isVotingScene(name){ return Object.prototype.hasOwnProperty.call(VOTE_DEFS, name); }
function isServerScene(name){ return SCENE_ORDER.some(s => s.name === name); }

// INITIAL index (first match of INITIAL_SCENE or 0)
const INITIAL_SCENE_ENV = process.env.INITIAL_SCENE || SCENE_ORDER[0].name;
let stateIdx = SCENE_ORDER.findIndex(s => s.name === INITIAL_SCENE_ENV);
if (stateIdx < 0) stateIdx = 0;
let state = SCENE_ORDER[stateIdx].name;

// -------- Vote Manager --------
class VoteManager {
  constructor(defs){
    this.scenes = {};
    for (const [name, { options, allowedClasses }] of Object.entries(defs)) {
      this.scenes[name] = {
        options: options.slice(),
        counts: Array(options.length).fill(0),
        voted: new Set(),
        allowedClasses: allowedClasses.slice(),
      };
    }
  }
  getSceneData(name){
    const s = this.scenes[name];
    return s ? { name, options: s.options, counts: s.counts, allowedClasses: s.allowedClasses } : null;
  }
  vote(name, sid, idx){
    const s = this.scenes[name]; if (!s) return { ok:false, reason:"unknown-scene" };
    if (s.voted.has(sid)) return { ok:false, reason:"already-voted" };
    if (idx < 0 || idx >= s.options.length) return { ok:false, reason:"bad-option" };
    s.counts[idx] += 1; s.voted.add(sid);
    return { ok:true };
  }
  resetScene(name){ const s = this.scenes[name]; if (!s) return; s.counts = Array(s.options.length).fill(0); s.voted.clear(); }
  clearVoted(name){ const s = this.scenes[name]; if (s) s.voted.clear(); }
}
const voteManager = new VoteManager(VOTE_DEFS);

// -------- Timer (server-authoritative) --------
const DEFAULT_ROUND_MS = 30_000;
let roundEndAt = null;
let roundDurationMs = DEFAULT_ROUND_MS;
let timerInterval = null;

function emitToJoinedAndAdmins(event, payload){
  io.sockets.sockets.forEach(s => {
    if (s.data?.joined || adminSockets.has(s.id)) s.emit(event, payload);
  });
}
function timerSnapshot(){
  const remainingMs = roundEndAt ? Math.max(0, roundEndAt - Date.now()) : 0;
  return { remainingMs, durationMs: roundDurationMs };
}
function broadcastTimer(){
  emitToJoinedAndAdmins("timer", timerSnapshot());
  if (roundEndAt && Date.now() >= roundEndAt) stopRoundTimer();
}
function startRoundTimer(durationMs = DEFAULT_ROUND_MS){
  stopRoundTimer();
  roundDurationMs = Math.max(1000, Number(durationMs) || DEFAULT_ROUND_MS);
  roundEndAt = Date.now() + roundDurationMs;
  timerInterval = setInterval(broadcastTimer, 250);
  broadcastTimer();
}
function stopRoundTimer(){
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  roundEndAt = null;
  emitToJoinedAndAdmins("timer", timerSnapshot());
}

// -------- Global maps --------
const adminSockets  = new Set();
const clientSockets = new Set();

// -------- Apply state change by INDEX (handles duplicates) --------
function applyStateIndex(newIdx) {
  const prevName = state;
  stateIdx = ((newIdx % SCENE_ORDER.length) + SCENE_ORDER.length) % SCENE_ORDER.length;
  state = SCENE_ORDER[stateIdx].name;

  if (state !== prevName && isVotingScene(state)) voteManager.clearVoted(state);

  emitToJoinedAndAdmins("state", { state, index: stateIdx });
  if (isVotingScene(state)) emitToJoinedAndAdmins("sceneData", voteManager.getSceneData(state));

  if (!isVotingScene(state)) stopRoundTimer(); else broadcastTimer();
}

// -------- API: clients per class --------
app.get("/clients", (_req, res) => {
  const perClass = { 1:0, 2:0, 3:0, 4:0, 5:0 };
  let total = 0;
  io.sockets.sockets.forEach((s) => {
    const cls = s.data?.userClass;
    if (s.data?.joined && [1,2,3,4,5].includes(cls)) {
      perClass[cls] += 1; total += 1;
    }
  });
  res.json({ total_joined: total, per_class: perClass });
});

// -------- API: Winner of the current vote --------
app.get("/winner", (_req, res) => {
  // If current scene is not a voting scene, respond accordingly
  if (!isVotingScene(state)) {
    return res.json({
      scene: state,
      vote_winner: null,
      votes: [],
      message: "No active voting scene"
    });
  }

  // Get the voting data for this scene
  const data = voteManager.getSceneData(state);
  if (!data) {
    return res.json({
      scene: state,
      vote_winner: null,
      votes: [],
      message: "No data for current scene"
    });
  }

  // Compute max count and all leaders
  const counts = data.counts;
  const max = Math.max(...counts);
  const leaders = counts
    .map((v, i) => ({ v, option: data.options[i] }))
    .filter(x => x.v === max);

  // Respond with the leader(s)
  res.json({
    scene: state,
    vote_winner: leaders.map(l => l.option),
    vote_count: max,
    votes: data.options.map((opt, i) => ({ option: opt, count: counts[i] }))
  });
});

// -------- Socket wiring --------
io.on("connection", (socket) => {
  socket.data = socket.data || {};
  socket.data.displayName = "";
  socket.data.userClass = null;
  socket.data.joined = false;

  // Send ordered list (index + name + type + meta)
  socket.emit("scenes", {
    scenes: SCENE_ORDER.map((s, i) => ({
      index: i, name: s.name, type: s.type,
      question: s.question || null,
      flavor: s.flavor || null
    }))
  });

  socket.on("identify", ({ role }) => {
    if (role === "admin") {
      adminSockets.add(socket.id);
      clientSockets.delete(socket.id);
      socket.emit("state", { state, index: stateIdx });
      if (isVotingScene(state)) socket.emit("sceneData", voteManager.getSceneData(state));
      socket.emit("timer", timerSnapshot());
    }
  });

  // Local (client) flow
  socket.on("setName", ({ name }) => {
    if (typeof name !== "string") return;
    socket.data.displayName = name.trim().slice(0, 40);
    socket.emit("nameSet", { ok:true, name: socket.data.displayName });
  });

  socket.on("setClass", ({ classId }) => {
    if (![1,2,3,4,5].includes(classId)) return;
    socket.data.userClass = classId;
    socket.emit("classSet", { classId });
  });

  socket.on("joinAfterClass", () => {
    if (socket.data.joined || !socket.data.userClass) return;
    socket.data.joined = true;
    clientSockets.add(socket.id);

    socket.emit("state", { state, index: stateIdx });
    if (isVotingScene(state)) socket.emit("sceneData", voteManager.getSceneData(state));
    socket.emit("timer", timerSnapshot());
  });

  // Admin: scene control
  socket.on("nextScene", () => {
    if (!adminSockets.has(socket.id)) return;
    applyStateIndex(stateIdx + 1);
  });
  socket.on("setStateIndex", (newIndex) => {
    if (!adminSockets.has(socket.id)) return;
    const i = Number(newIndex);
    if (!Number.isInteger(i) || i < 0 || i >= SCENE_ORDER.length) return;
    applyStateIndex(i);
  });
  socket.on("setState", (newName) => {
    if (!adminSockets.has(socket.id)) return;
    if (!isServerScene(newName)) return;
    const matches = SCENE_ORDER.map((s,i)=>({s,i})).filter(x=>x.s.name===newName).map(x=>x.i);
    if (!matches.length) return;
    const after = matches.find(i => i > stateIdx);
    applyStateIndex(after ?? matches[0]);
  });

  // Admin: reset + timer
  socket.on("resetScene", () => {
    if (!adminSockets.has(socket.id)) return;
    if (!isVotingScene(state)) return;
    voteManager.resetScene(state);
    emitToJoinedAndAdmins("sceneData", voteManager.getSceneData(state));
    emitToJoinedAndAdmins("sceneReset", { scene: state });
    broadcastTimer();
  });

  socket.on("startTimer", ({ seconds }) => {
    if (!adminSockets.has(socket.id)) return;
    if (!isVotingScene(state)) return;
    const secs = Math.max(1, Number(seconds) || (DEFAULT_ROUND_MS/1000));
    startRoundTimer(secs * 1000);
  });
  socket.on("stopTimer", () => {
    if (!adminSockets.has(socket.id)) return;
    stopRoundTimer();
  });

  // Voting
  socket.on("vote", ({ optionIndex }) => {
    if (!socket.data.joined) return;
    if (!isVotingScene(state)) return;

    if (!roundEndAt || Date.now() > roundEndAt) {
      socket.emit("voteError", { ok:false, reason:"round-ended" }); return;
    }
    const data = voteManager.getSceneData(state);
    const uc = socket.data.userClass;
    if (!uc || !data.allowedClasses.includes(uc)) {
      socket.emit("notEligible", { scene: state, required: data.allowedClasses }); return;
    }
    const res = voteManager.vote(state, socket.id, optionIndex);
    if (!res.ok) { socket.emit("voteError", res); return; }

    emitToJoinedAndAdmins("sceneData", voteManager.getSceneData(state));
    socket.emit("voted", { optionIndex });
  });

  socket.on("disconnect", () => {
    clientSockets.delete(socket.id);
    adminSockets.delete(socket.id);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("listening on :" + PORT, "| initial:", state, "index:", stateIdx));
