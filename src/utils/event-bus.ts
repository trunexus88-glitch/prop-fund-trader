/**
 * TRU-NEXUS Event Bus
 * Central event system for loose coupling between engine components.
 */
import EventEmitter from 'eventemitter3';
import type { EngineEvent } from '../engine/types.js';

class TruNexusEventBus extends EventEmitter {
  emitEngine(data: EngineEvent): void {
    this.emit('engine', data);
    this.emit(data.type, data);
  }
}

export const eventBus = new TruNexusEventBus();
