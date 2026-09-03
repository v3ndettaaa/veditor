/**
 * Layer Management System
 * Supports unlimited layers, visibility toggling, layer locking, opacity, and ordering.
 */

import { Layer, Annotation } from '../core/types';
import { store } from '../core/store';

export class LayerManager {
  public getOrCreateDefaultLayers(pageIndex: number): Layer[] {
    const doc = store.activeDocument;
    if (!doc) return [];

    if (!doc.layers[pageIndex] || doc.layers[pageIndex].length === 0) {
      doc.layers[pageIndex] = [
        {
          id: 'layer-default',
          name: 'Default Layer',
          visible: true,
          locked: false,
          opacity: 1.0,
          order: 0
        }
      ];
    }

    return doc.layers[pageIndex];
  }

  public addLayer(pageIndex: number, name?: string): Layer {
    const doc = store.activeDocument;
    if (!doc) throw new Error('No active document');

    const layers = this.getOrCreateDefaultLayers(pageIndex);
    const newLayer: Layer = {
      id: `layer-${Math.random().toString(36).substring(2, 9)}`,
      name: name || `Layer ${layers.length + 1}`,
      visible: true,
      locked: false,
      opacity: 1.0,
      order: layers.length
    };

    doc.layers[pageIndex].push(newLayer);
    doc.lastModifiedAt = Date.now();
    return newLayer;
  }

  public toggleLayerVisibility(pageIndex: number, layerId: string): void {
    const doc = store.activeDocument;
    if (!doc || !doc.layers[pageIndex]) return;

    const layer = doc.layers[pageIndex].find(l => l.id === layerId);
    if (layer) {
      layer.visible = !layer.visible;
      doc.lastModifiedAt = Date.now();
    }
  }

  public toggleLayerLock(pageIndex: number, layerId: string): void {
    const doc = store.activeDocument;
    if (!doc || !doc.layers[pageIndex]) return;

    const layer = doc.layers[pageIndex].find(l => l.id === layerId);
    if (layer) {
      layer.locked = !layer.locked;
      doc.lastModifiedAt = Date.now();
    }
  }

  public setLayerOpacity(pageIndex: number, layerId: string, opacity: number): void {
    const doc = store.activeDocument;
    if (!doc || !doc.layers[pageIndex]) return;

    const layer = doc.layers[pageIndex].find(l => l.id === layerId);
    if (layer) {
      layer.opacity = Math.max(0, Math.min(1, opacity));
      doc.lastModifiedAt = Date.now();
    }
  }

  public filterVisibleAnnotations(pageIndex: number, annotations: Annotation[]): Annotation[] {
    const doc = store.activeDocument;
    if (!doc || !doc.layers[pageIndex]) return annotations;

    const hiddenLayerIds = new Set(
      doc.layers[pageIndex].filter(l => !l.visible).map(l => l.id)
    );

    return annotations.filter(a => !hiddenLayerIds.has(a.layerId));
  }
}

export const layerManager = new LayerManager();
