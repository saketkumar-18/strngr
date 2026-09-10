/* strngr client — anonymous video + text chat
   Privacy: nothing is persisted; video/audio flows peer-to-peer, not via the server.
   Omegle-parity: instant queue join (camera never blocks matching), composer
   disabled until matched, optimistic message send, explicit re-find button. */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);

  // ---------- config ----------
  const ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ],
  };

  // ---------- state ----------
  let socket = null;
  let mode = null;            // 'video' | 'text'
  let inChat = false;         // currently matched
  let searching = false;
  let stream = null;          // local camera/mic (may arrive late, or never)
  let camState = 'unknown';   // 'on' | 'off' | 'unknown'
  let mediaRequested = false; // avoid duplicate permission prompts
  let pc = null;              // RTCPeerConnection
  let polite = false;         // perfect-negotiation role
  let makingOffer = false;
  let ignoreOffer = false;
  let queuedCandidates = [];
  let typingTimer = null;

  // ---------- tiny helpers ----------
  const toast = (() => {
    const el = $('toast'); let t;
    return (msg, ms = 2600) => {
      el.textContent = msg; el.classList.add('show');
      clearTimeout(t); t = setTimeout(() => el.classList.remove('show'), ms);
    };
  })();

  function fmtTime() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ---------- landing ----------
  function showLanding() {
    $('chat').style.display = 'none';
    $('landing').style.display = 'flex';
  }

  function startChat(nextMode) {
    mode = nextMode;
    $('landing').style.display = 'none';
    $('chat').style.display = 'flex';
    $('videoWrap').style.display = mode === 'video' ? 'block' : 'none';
    $('textWrap').style.display = mode === 'text' ? 'flex' : 'none';
    $('reportBtn').style.display = 'inline-block';
    $('skipBtn').style.display = 'inline-block';
    if (mode === 'text') {
      setComposer(false, 'Waiting for a stranger…');
      sysMsg('Looking for someone to talk to…');
    }
    if (!socket) connect();
    if (mode === 'video') beginVideoSearch();
    else findPartner();
  }

  // ---------- composer gating (Omegle-style: unusable until matched) ----------
  function setComposer(enabled, placeholder) {
    const input = $('msgInput');
    const btn = $('sendBtn');
    input.disabled = !enabled;
    btn.disabled = !enabled;
    if (placeholder !== undefined) input.placeholder = placeholder;
  }

  // ---------- socket ----------
  function connect() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => { if (searching) findPartner(); });

    socket.on('connect_error', () => {
      if (inChat || searching) {
        setStatus('Connection lost. Check your internet.', 'r');
        cleanupPartner('lost');
      }
    });

    socket.on('online-count', ({ online }) => {
      const s = `${online} online`;
      $('onlineBadge').textContent = s;
      $('onlinePill').textContent = s === '1 online' ? 'you alone for now — share the link' : `${s} right now`;
    });

    socket.on('searching', ({ online }) => {
      searching = true;
      inChat = false;
      const suffix = online > 1 ? ` (${online} online)` : '';
      setStatus(mode === 'video' ? 'Looking for a stranger…' : 'Finding someone to talk to…' + suffix, 'a');
      if (mode === 'text') setComposer(false, 'Waiting for a stranger…');
      if (mode === 'video') videoCenter(true, null, 'Looking for a stranger…');
    });

    socket.on('matched', ({ initiator }) => {
      inChat = true; searching = false;
      if (mode === 'video') {
        polite = !initiator;          // initiator is impolite
        setStatus('Stranger connected — say hi!', 'g');
        startPeerConnection(initiator);
      } else {
        setStatus("You're now chatting with a random stranger", 'g');
        sysMsg("You're now chatting with a random stranger. Say hi!");
        setComposer(true, 'Type a message…');
        $('msgInput').focus();
      }
    });

    socket.on('text-message', ({ text }) => {
      addMsg('them', text);
      typingOff();
    });

    socket.on('typing', ({ on }) => { on ? typingOn() : typingOff(); });

    socket.on('partner-left', ({ reason }) => {
      const skipped = reason === 'skip';
      if (mode === 'video') {
        setStatus(skipped ? 'Stranger skipped you' : 'Stranger disconnected', 'r');
        videoCenter(true, skipped ? '💨' : '👋', skipped ? 'Stranger skipped you' : 'Stranger left');
      } else {
        setStatus(skipped ? 'Stranger disconnected' : 'Stranger disconnected', 'r');
        sysMsg('Stranger disconnected.');
      }
      sysFindButton();
      setComposer(false, 'Waiting for a stranger…');
      cleanupPartner();
    });

    socket.on('signal', ({ data }) => handleSignal(data));
    socket.on('media-state', ({ video, audio }) => applyRemoteMediaState(video, audio));
  }

  function findPartner() {
    searching = true;
    socket.emit('find-partner', { channel: mode }, () => {});
  }

  function setStatus(text, tone) {
    $('statusText').textContent = text;
    $('statusDot').className = 'dot ' + (tone || 'a');
  }

  // ---------- text UI ----------
  function sysMsg(text) {
    const row = document.createElement('div');
    row.className = 'sysmsg';
    const s = document.createElement('span');
    s.textContent = text;
    row.appendChild(s);
    $('messages').appendChild(row);
    scrollDown();
  }

  // Omegle-style inline "start a new chat" action after a chat ends
  function sysFindButton() {
    if (mode !== 'text') return;
    const row = document.createElement('div');
    row.className = 'sysmsg';
    const b = document.createElement('button');
    b.textContent = '⟳ Find a new stranger';
    b.style.cssText = 'font:inherit;font-size:.8rem;font-weight:600;color:#22d3ee;background:#171b26;border:1px solid #2e3648;border-radius:999px;padding:6px 14px;cursor:pointer';
    b.addEventListener('click', () => {
      b.disabled = true;
      b.textContent = 'Looking…';
      findPartner();
    });
    row.appendChild(b);
    $('messages').appendChild(row);
    scrollDown();
  }

  function addMsg(who, text) {
    const row = document.createElement('div');
    row.className = 'msg ' + (who === 'you' ? 'you' : 'them');
    const bub = document.createElement('div');
    bub.className = 'bub';
    const body = document.createElement('span');
    body.textContent = text; // textContent => no HTML injection ever
    const time = document.createElement('time');
    time.textContent = fmtTime();
    bub.append(body, time);
    row.appendChild(bub);
    $('messages').appendChild(row);
    scrollDown();
  }

  let typingRow = null;
  function typingOn() {
    if (typingRow) return;
    typingRow = document.createElement('div');
    typingRow.className = 'typing-row';
    typingRow.innerHTML = '<div class="bub"><i></i><i></i><i></i></div>';
    $('messages').appendChild(typingRow);
    scrollDown();
  }
  function typingOff() {
    if (typingRow) { typingRow.remove(); typingRow = null; }
  }

  function scrollDown() {
    const m = $('messages');
    m.scrollTop = m.scrollHeight;
  }

  // optimistic send: message shows immediately; ack only flags failures
  function sendText() {
    if (!socket) return;
    const input = $('msgInput');
    const text = input.value.trim();
    if (!text) return;
    if (!inChat) {
      toast('Still waiting for a stranger — messages send once connected');
      return;
    }
    input.value = '';
    addMsg('you', text);
    socket.emit('text-message', { text }, (res) => {
      if (!res || !res.ok) toast('Message may not have been delivered');
    });
  }

  // ---------- video UI ----------
  function videoCenter(show, emoji, label) {
    const c = $('videoCenter');
    c.style.display = show ? 'flex' : 'none';
    if (emoji) {
      $('videoEmoji').textContent = emoji;
      $('videoEmoji').style.display = 'block';
      $('videoSpinner').style.display = 'none';
    }
    if (label) $('videoLabel').textContent = label;
  }

  // join the video queue IMMEDIATELY — camera permission never blocks matching
  function beginVideoSearch() {
    videoCenter(true, null, 'Looking for a stranger…');
    $('videoSpinner').style.display = 'block';
    $('videoEmoji').style.display = 'none';
    $('videoControls').style.display = 'flex';
    $('reconnectNote').style.display = 'none';
    setStatus('Looking for a stranger…', 'a');
    findPartner();   // instant queue join
    ensureMedia();   // camera prompt runs in parallel
  }

  async function ensureMedia() {
    if (stream || mediaRequested) return;
    mediaRequested = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: true,
      });
      camState = 'on';
      $('localVideo').srcObject = stream;
      wireStreamIntoPC();
      emitMediaState();
    } catch (err) {
      camState = 'off';
      toast('Camera/mic unavailable — you can still chat (partner sees camera off)', 4000);
      emitMediaState();
    } finally {
      mediaRequested = false;
    }
  }

  function applyRemoteMediaState(video) {
    const rv = $('remoteVideo');
    if (!video) {
      rv.style.opacity = '0.06';
      if (inChat) videoCenter(true, '🎥', "Stranger's camera is off");
    } else {
      rv.style.opacity = '1';
      if (inChat) videoCenter(false);
    }
  }

  // ---------- WebRTC (perfect negotiation) ----------
  function startPeerConnection(isInitiator) {
    closePC();
    queuedCandidates = [];
    makingOffer = false; ignoreOffer = false;
    pc = new RTCPeerConnection(ICE);

    pc.onicecandidate = (e) => {
      if (e.candidate && inChat) socket.emit('signal', { data: { candidate: e.candidate.toJSON() } });
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      const st = pc.connectionState;
      $('reconnectNote').style.display = (st === 'disconnected' || st === 'failed') && inChat ? 'block' : 'none';
      if (st === 'connected') {
        if (inChat && !videoOverlayNeeded()) videoCenter(false);
        setStatus('Connected — talking to a stranger', 'g');
        if (camState === 'off') toast("You're chatting without camera — partner sees it off", 3000);
      }
      if ((st === 'failed') && inChat) {
        try { pc.restartIce(); } catch (_) {}
      }
    };
    pc.ontrack = (e) => {
      if ($('remoteVideo').srcObject !== e.streams[0]) {
        $('remoteVideo').srcObject = e.streams[0];
        $('remoteVideo').style.opacity = '1';
        if (inChat && !videoOverlayNeeded()) videoCenter(false);
      }
    };

    if (stream) {
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
    } else {
      // pre-declare media sections so the connection carries audio+video even
      // before the camera arrives; replaceTrack() wires it in later
      try {
        pc.addTransceiver('video', { direction: 'sendrecv' });
        pc.addTransceiver('audio', { direction: 'sendrecv' });
      } catch (_) {}
    }

    if (isInitiator) {
      (async () => {
        try {
          makingOffer = true;
          await pc.setLocalDescription();
          socket.emit('signal', { data: { description: pc.localDescription } });
        } catch (err) { /* ignore */ }
        finally { makingOffer = false; }
      })();
    }
  }

  // late camera: attach to the already-negotiated PC via replaceTrack
  function wireStreamIntoPC() {
    if (!pc || !stream) return;
    const v = stream.getVideoTracks()[0] || null;
    const a = stream.getAudioTracks()[0] || null;
    for (const t of pc.getTransceivers()) {
      const kind = t.receiver && t.receiver.track ? t.receiver.track.kind : null;
      if (kind === 'video' && v) { try { t.sender.replaceTrack(v); t.direction = 'sendrecv'; } catch (_) {} }
      if (kind === 'audio' && a) { try { t.sender.replaceTrack(a); t.direction = 'sendrecv'; } catch (_) {} }
    }
  }

  function videoOverlayNeeded() {
    // keep the "camera off" overlay if the partner has no video
    const rv = $('remoteVideo');
    return rv.style.opacity === '0.06';
  }

  async function handleSignal({ description, candidate }) {
    if (!pc) return;
    try {
      if (description) {
        const offerCollision = description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
        ignoreOffer = !polite && offerCollision;
        if (ignoreOffer) return;

        await pc.setRemoteDescription(description); // implicit rollback for polite peer
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          socket.emit('signal', { data: { description: pc.localDescription } });
        }
        const queued = queuedCandidates; queuedCandidates = [];
        for (const c of queued) { try { await pc.addIceCandidate(c); } catch (_) {} }
      } else if (candidate) {
        if (!pc.remoteDescription) queuedCandidates.push(candidate);
        else { try { await pc.addIceCandidate(candidate); } catch (_) {} }
      }
    } catch (err) {
      if (!ignoreOffer) { /* tolerate mid-teardown races */ }
    }
  }

  function emitMediaState() {
    if (!socket) return;
    const v = stream ? stream.getVideoTracks()[0] : null;
    const a = stream ? stream.getAudioTracks()[0] : null;
    socket.emit('media-state', { video: !!(v && v.enabled), audio: !!(a && a.enabled) });
  }

  function closePC() {
    // Close the peer connection only. NEVER stop sender tracks — getSenders()
    // returns OUR camera/mic tracks; stopping them would kill the camera for
    // the next stranger. Local stream lifecycle is handled by stopLocalStream().
    if (pc) { try { pc.close(); } catch (_) {} pc = null; }
    const rv = $('remoteVideo');
    if (rv) { rv.srcObject = null; rv.style.opacity = '1'; }
  }

  function stopLocalStream() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    camState = 'unknown';
    if ($('localVideo')) $('localVideo').srcObject = null;
  }

  function cleanupPartner(reason) {
    inChat = false;
    searching = false;
    typingOff();
    closePC();
    if (mode === 'video') {
      $('videoControls').style.display = 'none';
      $('reconnectNote').style.display = 'none';
      if (reason === 'lost') videoCenter(true, '📡', 'Connection lost');
    }
  }

  // ---------- buttons ----------
  $('videoCard').addEventListener('click', () => startChat('video'));
  $('textCard').addEventListener('click', () => startChat('text'));
  $('navStart').addEventListener('click', (e) => { e.preventDefault(); startChat('video'); });

  $('skipBtn').addEventListener('click', () => {
    if (!socket) return;
    if (inChat) { socket.emit('skip'); sysMsg('You skipped the stranger.'); }
    sysFindButton();
    if (mode === 'video') beginVideoSearch(); else { sysMsg('Looking for someone new…'); findPartner(); }
  });

  $('reportBtn').addEventListener('click', () => {
    if (!socket || !inChat) { toast('No one to report right now'); return; }
    socket.emit('report');
    if (mode === 'text') { sysMsg('Reported. Finding you a new conversation is up to you — click Next.'); sysFindButton(); }
    toast('Reported. The other person was not told it was you.');
    cleanupPartner();
    if (mode === 'video') videoCenter(true, '🚩', 'Reported. Tap Next for someone new.');
    setStatus('You reported the stranger', 'a');
  });

  $('msgInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendText(); }
  });
  $('msgInput').addEventListener('input', () => {
    if (!inChat || !socket) return;
    socket.emit('typing', { on: true });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => socket.emit('typing', { on: false }), 1200);
  });
  $('sendBtn').addEventListener('click', sendText);

  $('camToggle').addEventListener('click', () => {
    if (!stream) { ensureMedia(); return; }  // retry camera if it never came up
    const t = stream.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    $('camToggle').classList.toggle('off', !t.enabled);
    emitMediaState();
  });
  $('micToggle').addEventListener('click', () => {
    if (!stream) { ensureMedia(); return; }
    const t = stream.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    $('micToggle').classList.toggle('off', !t.enabled);
    emitMediaState();
  });
  $('videoNext').addEventListener('click', () => {
    if (inChat) socket.emit('skip');
    beginVideoSearch();
  });
  $('videoStop').addEventListener('click', () => {
    if (socket) { socket.emit('stop-searching'); socket.emit('skip'); }
    cleanupPartner();
    stopLocalStream();
    showLanding();
  });
})();
