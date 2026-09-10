/* strngr client — anonymous video + text chat
   Privacy: nothing is persisted; video/audio flows peer-to-peer, not via the server. */
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
  let stream = null;          // local camera/mic
  let pc = null;              // RTCPeerConnection
  let polite = false;         // perfect-negotiation role
  let makingOffer = false;
  let ignoreOffer = false;
  let queuedCandidates = [];
  const pendingAcks = new Set();
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
    if (!socket) connect();
    if (mode === 'video') beginVideoSearch();
    else findPartner();
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

    socket.on('searching', () => {
      searching = true;
      inChat = false;
      setStatus(mode === 'video' ? 'Looking for a stranger…' : 'Finding someone to talk to…', 'a');
      if (mode === 'video') videoCenter(true, '🔍', 'Looking for a stranger…');
    });

    socket.on('matched', ({ initiator }) => {
      inChat = true; searching = false;
      if (mode === 'video') {
        polite = !initiator;          // initiator is impolite
        setStatus('Stranger connected — say hi!', 'g');
        startPeerConnection(initiator);
      } else {
        setStatus('You\'re now chatting with a random stranger', 'g');
        sysMsg('You\'re now chatting with a random stranger. Say hi!');
      }
    });

    socket.on('text-message', ({ text }) => {
      addMsg('them', text);
      typingOff();
    });

    socket.on('typing', ({ on }) => { on ? typingOn() : typingOff(); });

    socket.on('partner-left', ({ reason }) => {
      if (reason === 'skip') {
        if (mode === 'video') { setStatus('Stranger skipped you', 'r'); videoCenter(true, '💨', 'Stranger skipped you'); }
        else { setStatus('Stranger disconnected', 'r'); sysMsg('Stranger disconnected.'); }
      } else {
        if (mode === 'video') { setStatus('Stranger disconnected', 'r'); videoCenter(true, '👋', 'Stranger left'); }
        else { setStatus('Stranger disconnected', 'r'); sysMsg('Stranger disconnected.'); }
      }
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
  function typingRowRemove() { typingOff(); }

  function scrollDown() {
    const m = $('messages');
    m.scrollTop = m.scrollHeight;
  }

  function sendText() {
    const input = $('msgInput');
    const text = input.value.trim();
    if (!text || !inChat || !socket) return;
    socket.emit('text-message', { text }, (res) => {
      if (res && res.ok) {
        addMsg('you', text);
        input.value = '';
        socket.emit('typing', { on: false });
      } else {
        toast('Not delivered — you may have been skipped');
      }
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

  async function beginVideoSearch() {
    videoCenter(true, null, 'Looking for a stranger…');
    $('videoSpinner').style.display = 'block';
    $('videoEmoji').style.display = 'none';
    $('videoControls').style.display = 'none';
    $('reconnectNote').style.display = 'none';
    if (!stream) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: true });
        $('localVideo').srcObject = stream;
      } catch (err) {
        // no camera/mic (or blocked) — graceful fallback to text
        toast('Camera unavailable — starting text chat instead', 3200);
        startChat('text');
        return;
      }
    }
    setStatus('Looking for a stranger…', 'a');
    findPartner();
  }

  function applyRemoteMediaState(video, audio) {
    const rv = $('remoteVideo');
    rv.dataset.videoOn = video ? '1' : '0';
    if (!video) {
      rv.style.opacity = '0.06';
      if (inChat) videoCenter(true, '🎥', 'Stranger\'s camera is off');
    } else {
      rv.style.opacity = '1';
      videoCenter(false);
    }
    $('reconnectNote').dataset.micOff = audio ? '0' : '1';
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
        videoCenter(false);
        $('videoControls').style.display = 'flex';
        setStatus('Connected — talking to a stranger', 'g');
      }
      if ((st === 'failed') && inChat) {
        try { pc.restartIce(); } catch (_) {}
      }
    };
    pc.ontrack = (e) => {
      if ($('remoteVideo').srcObject !== e.streams[0]) {
        $('remoteVideo').srcObject = e.streams[0];
        $('remoteVideo').style.opacity = '1';
        videoCenter(false);
        $('videoControls').style.display = 'flex';
      }
    };

    if (stream) {
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      emitMediaState();
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
        // flush candidates queued while no remote description existed
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
    if (!socket || !stream) return;
    const v = stream.getVideoTracks()[0];
    const a = stream.getAudioTracks()[0];
    socket.emit('media-state', { video: !!(v && v.enabled), audio: !!(a && a.enabled) });
  }

  function closePC() {
    // Close the peer connection only. NEVER stop sender tracks — getSenders()
    // returns OUR camera/mic tracks; stopping them would kill the camera for
    // the next stranger. Local stream lifecycle is handled by stopLocalStream().
    if (pc) { try { pc.close(); } catch (_) {} pc = null; }
    const rv = $('remoteVideo');
    if (rv) { rv.srcObject = null; rv.style.opacity = '1'; rv.dataset.videoOn = '1'; }
  }

  function stopLocalStream() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
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
    if (mode === 'video') beginVideoSearch(); else { sysMsg('Looking for someone new…'); findPartner(); }
  });

  $('reportBtn').addEventListener('click', () => {
    if (!socket || !inChat) { toast('No one to report right now'); return; }
    socket.emit('report');
    if (mode === 'text') sysMsg('Reported. Finding you a new conversation is up to you — click Next.');
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
    if (!stream) return;
    const t = stream.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    $('camToggle').classList.toggle('off', !t.enabled);
    emitMediaState();
  });
  $('micToggle').addEventListener('click', () => {
    if (!stream) return;
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
