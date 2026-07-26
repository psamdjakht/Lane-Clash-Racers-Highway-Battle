(() => {
  'use strict';
  const STORAGE_ROOMS = 'lcr-demo-rooms-v1';
  const nowIso = () => new Date().toISOString();
  const clone = value => JSON.parse(JSON.stringify(value));
  const makeId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const makeCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();

  class LCRNetwork {
    constructor(config) {
      this.config = config || {};
      this.client = null;
      this.mode = 'demo';
      this.lobbyChannel = null;
      this.roomChannels = [];
      this.gameChannel = null;
      this.localGameChannel = null;
      this.localLobbyListener = null;
    }

    async init() {
      const url = this.config.SUPABASE_URL || '';
      const key = this.config.SUPABASE_ANON_KEY || '';
      const configured = /^https:\/\/.+\.supabase\.co$/i.test(url) && !key.includes('YOUR_') && key.length > 30;
      if (!configured) {
        this.mode = 'demo';
        this.cleanupExpiredLocalRooms();
        return { mode: this.mode };
      }
      try {
        await this.loadSupabaseLibrary();
        this.client = window.supabase.createClient(url, key, {
          auth: { persistSession: false, autoRefreshToken: false },
          realtime: { params: { eventsPerSecond: 20 } }
        });
        const { error } = await this.client.from('rooms').select('id').limit(1);
        if (error) throw error;
        this.mode = 'online';
      } catch (error) {
        console.warn('Không kết nối được Supabase, chuyển sang Demo:', error);
        this.client = null;
        this.mode = 'demo';
      }
      return { mode: this.mode };
    }

    get isOnline() { return this.mode === 'online'; }

    async loadSupabaseLibrary() {
      if (window.supabase?.createClient) return;
      await new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-lcr-supabase]');
        if (existing) {
          existing.addEventListener('load', resolve, { once: true });
          existing.addEventListener('error', reject, { once: true });
          return;
        }
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
        script.async = true;
        script.dataset.lcrSupabase = '1';
        script.onload = resolve;
        script.onerror = () => reject(new Error('Không tải được thư viện Supabase.'));
        document.head.appendChild(script);
        setTimeout(() => reject(new Error('Quá thời gian tải thư viện Supabase.')), 12000);
      });
      if (!window.supabase?.createClient) throw new Error('Thư viện Supabase không hợp lệ.');
    }

    cleanupExpiredLocalRooms() {
      const hours = Number(this.config.ROOM_EXPIRE_HOURS || 12);
      const cutoff = Date.now() - hours * 3600000;
      const rooms = this.readLocalRooms().filter(r => new Date(r.updated_at || r.created_at).getTime() >= cutoff);
      this.writeLocalRooms(rooms);
    }

    readLocalRooms() {
      try { return JSON.parse(localStorage.getItem(STORAGE_ROOMS) || '[]'); }
      catch { return []; }
    }

    writeLocalRooms(rooms) {
      try { localStorage.setItem(STORAGE_ROOMS, JSON.stringify(rooms)); } catch (error) { console.warn('Không ghi được phòng cục bộ:', error); }
      window.dispatchEvent(new CustomEvent('lcr-local-rooms'));
    }

    async listRooms() {
      if (!this.isOnline) {
        return this.readLocalRooms().filter(r => r.status === 'waiting').map(clone);
      }
      const { data: rooms, error } = await this.client
        .from('rooms')
        .select('*')
        .eq('status', 'waiting')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      if (!rooms?.length) return [];
      const ids = rooms.map(r => r.id);
      const { data: players, error: pError } = await this.client
        .from('room_players')
        .select('room_id')
        .in('room_id', ids);
      if (pError) throw pError;
      const counts = {};
      for (const p of players || []) counts[p.room_id] = (counts[p.room_id] || 0) + 1;
      return rooms.map(r => ({ ...r, player_count: counts[r.id] || 0 }));
    }

    async createRoom(settings, profile) {
      const code = makeCode();
      const room = {
        id: makeId(), code, name: settings.name, host_id: profile.id, status: 'waiting',
        mode: settings.mode, max_players: settings.maxPlayers, lane_count: settings.laneCount,
        duration_seconds: settings.durationSeconds, ai_difficulty: settings.aiDifficulty,
        obstacle_density: settings.obstacleDensity, powerup_density: settings.powerupDensity,
        seed: Math.floor(Math.random() * 2147483640), settings,
        created_at: nowIso(), updated_at: nowIso(), player_count: 1
      };
      const player = this.makePlayerRow(room.id, profile, true, 0);
      if (!this.isOnline) {
        room.players = [player];
        const rooms = this.readLocalRooms();
        rooms.unshift(room);
        this.writeLocalRooms(rooms);
        return clone(room);
      }
      const dbRoom = { ...room };
      delete dbRoom.player_count;
      delete dbRoom.players;
      const { data, error } = await this.client.from('rooms').insert(dbRoom).select().single();
      if (error) throw error;
      const { error: pError } = await this.client.from('room_players').insert(player);
      if (pError) throw pError;
      return { ...data, player_count: 1 };
    }

    makePlayerRow(roomId, profile, isHost, slot) {
      return {
        id: makeId(), room_id: roomId, player_id: profile.id, name: profile.name,
        avatar: profile.avatar, color: profile.color ?? slot % 8, is_host: !!isHost,
        is_ready: true, slot, joined_at: nowIso(), last_seen: nowIso()
      };
    }

    async getRoom(code) {
      code = String(code || '').toUpperCase();
      if (!this.isOnline) {
        const room = this.readLocalRooms().find(r => r.code === code);
        return room ? clone(room) : null;
      }
      const { data: room, error } = await this.client.from('rooms').select('*').eq('code', code).maybeSingle();
      if (error) throw error;
      if (!room) return null;
      const { data: players, error: pError } = await this.client.from('room_players').select('*').eq('room_id', room.id).order('slot');
      if (pError) throw pError;
      return { ...room, players: players || [], player_count: (players || []).length };
    }

    async joinRoom(code, profile) {
      const room = await this.getRoom(code);
      if (!room) throw new Error('Không tìm thấy phòng.');
      if (room.status !== 'waiting') throw new Error('Phòng đã bắt đầu hoặc đã đóng.');
      const current = room.players || [];
      const existing = current.find(p => p.player_id === profile.id);
      if (existing) return room;
      if (current.length >= room.max_players) throw new Error('Phòng đã đủ người.');
      const usedSlots = new Set(current.map(p => p.slot));
      let slot = 0; while (usedSlots.has(slot)) slot++;
      const player = this.makePlayerRow(room.id, profile, false, slot);
      if (!this.isOnline) {
        const rooms = this.readLocalRooms();
        const index = rooms.findIndex(r => r.id === room.id);
        rooms[index].players.push(player);
        rooms[index].player_count = rooms[index].players.length;
        rooms[index].updated_at = nowIso();
        this.writeLocalRooms(rooms);
        return clone(rooms[index]);
      }
      let candidate = player;
      for (let attempt = 0; attempt < 3; attempt++) {
        const { error } = await this.client.from('room_players').insert(candidate);
        if (!error) {
          await this.touchRoom(room.id);
          return this.getRoom(code);
        }
        if (error.code !== '23505') throw error;
        const latest = await this.getRoom(code);
        if (!latest || (latest.players || []).length >= latest.max_players) throw new Error('Phòng đã đủ người.');
        const occupied = new Set((latest.players || []).map(p => p.slot));
        let nextSlot = 0; while (occupied.has(nextSlot)) nextSlot++;
        candidate = this.makePlayerRow(room.id, profile, false, nextSlot);
      }
      throw new Error('Không thể chọn slot trống. Hãy thử lại.');
    }

    async touchRoom(roomId) {
      if (!this.isOnline) return;
      await this.client.from('rooms').update({ updated_at: nowIso() }).eq('id', roomId);
    }

    async leaveRoom(room, playerId) {
      if (!room) return;
      const player = (room.players || []).find(p => p.player_id === playerId);
      const isHost = player?.is_host || room.host_id === playerId;
      if (!this.isOnline) {
        let rooms = this.readLocalRooms();
        const index = rooms.findIndex(r => r.id === room.id);
        if (index < 0) return;
        if (isHost) rooms.splice(index, 1);
        else {
          rooms[index].players = (rooms[index].players || []).filter(p => p.player_id !== playerId);
          rooms[index].player_count = rooms[index].players.length;
          rooms[index].updated_at = nowIso();
        }
        this.writeLocalRooms(rooms);
        return;
      }
      if (isHost) await this.client.from('rooms').delete().eq('id', room.id);
      else {
        await this.client.from('room_players').delete().eq('room_id', room.id).eq('player_id', playerId);
        await this.touchRoom(room.id);
      }
    }

    async setRoomStatus(roomId, status) {
      if (!this.isOnline) {
        const rooms = this.readLocalRooms();
        const i = rooms.findIndex(r => r.id === roomId);
        if (i >= 0) { rooms[i].status = status; rooms[i].updated_at = nowIso(); this.writeLocalRooms(rooms); }
        return;
      }
      const { error } = await this.client.from('rooms').update({ status, updated_at: nowIso() }).eq('id', roomId);
      if (error) throw error;
    }

    subscribeLobby(callback) {
      this.unsubscribeLobby();
      if (!this.isOnline) {
        const handler = () => callback();
        window.addEventListener('storage', handler);
        window.addEventListener('lcr-local-rooms', handler);
        this.localLobbyListener = handler;
        return;
      }
      this.lobbyChannel = this.client.channel(`lobby-${makeId()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, callback)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'room_players' }, callback)
        .subscribe();
    }

    unsubscribeLobby() {
      if (this.lobbyChannel && this.client) this.client.removeChannel(this.lobbyChannel);
      this.lobbyChannel = null;
      if (this.localLobbyListener) {
        window.removeEventListener('storage', this.localLobbyListener);
        window.removeEventListener('lcr-local-rooms', this.localLobbyListener);
      }
      this.localLobbyListener = null;
    }

    subscribeRoom(room, callback) {
      this.unsubscribeRoom();
      if (!this.isOnline) {
        const handler = async () => callback(await this.getRoom(room.code));
        window.addEventListener('storage', handler);
        window.addEventListener('lcr-local-rooms', handler);
        this.roomChannels = [{ localHandler: handler }];
        return;
      }
      const ch = this.client.channel(`room-db-${room.code}-${makeId()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${room.id}` }, async () => callback(await this.getRoom(room.code)))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'room_players', filter: `room_id=eq.${room.id}` }, async () => callback(await this.getRoom(room.code)))
        .subscribe();
      this.roomChannels = [ch];
    }

    unsubscribeRoom() {
      for (const ch of this.roomChannels) {
        if (ch.localHandler) {
          window.removeEventListener('storage', ch.localHandler);
          window.removeEventListener('lcr-local-rooms', ch.localHandler);
        } else if (this.client) this.client.removeChannel(ch);
      }
      this.roomChannels = [];
    }

    async openGameChannel(roomCode, playerId, onMessage) {
      await this.closeGameChannel();
      if (!this.isOnline) {
        this.localGameChannel = new BroadcastChannel(`lcr-game-${roomCode}`);
        this.localGameChannel.onmessage = event => onMessage(event.data);
        this.gameChannel = {
          send: async payload => this.localGameChannel?.postMessage(payload),
          track: async () => {},
          unsubscribe: async () => this.localGameChannel?.close()
        };
        return this.gameChannel;
      }
      const channel = this.client.channel(`lcr-game-${roomCode}`, {
        config: { broadcast: { self: false, ack: false }, presence: { key: playerId } }
      });
      channel.on('broadcast', { event: 'game' }, ({ payload }) => onMessage(payload));
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Quá thời gian kết nối phòng game.')), 10000);
        channel.subscribe(async status => {
          if (status === 'SUBSCRIBED') {
            clearTimeout(timeout);
            await channel.track({ player_id: playerId, online_at: nowIso() });
            resolve();
          }
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            clearTimeout(timeout); reject(new Error('Không mở được kênh Realtime.'));
          }
        });
      });
      this.gameChannel = {
        send: payload => channel.send({ type: 'broadcast', event: 'game', payload }),
        track: state => channel.track(state),
        unsubscribe: () => this.client.removeChannel(channel),
        raw: channel
      };
      return this.gameChannel;
    }

    async sendGame(payload) {
      if (!this.gameChannel) return;
      await this.gameChannel.send(payload);
    }

    async closeGameChannel() {
      if (this.gameChannel?.unsubscribe) await this.gameChannel.unsubscribe();
      if (this.localGameChannel) this.localGameChannel.close();
      this.gameChannel = null;
      this.localGameChannel = null;
    }
  }

  window.LCRNetwork = LCRNetwork;
})();
