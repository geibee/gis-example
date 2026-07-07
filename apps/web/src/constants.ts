import type { BusinessLinks } from "./types";

export const baseStyle = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors"
    }
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }]
};

export const attributeOperators = ["=", "!=", "<", "<=", ">", ">=", "LIKE", "IN", "IS NULL"];
export const conditionSpatialOperators = [
  { value: "intersects", label: "重なる" },
  { value: "contains", label: "区域が含む" },
  { value: "within", label: "区域が含まれる" },
  { value: "dwithin", label: "指定距離内" }
];
export const layerColors = ["#0f766e", "#b45309", "#2563eb", "#be123c", "#7c3aed", "#15803d", "#c2410c"];
export const imperialPalaceCenter: [number, number] = [139.7528, 35.6852];
export const defaultMapZoom = 12.5;
export const layerViewStateStoragePrefix = "gis-example.layer-view-state.";
export const businessMapHighlightLimit = 80;
export const businessStatusOptions = ["調査中", "現況確認中", "交渉中", "契約準備", "契約済", "稼働中", "保留", "除外"];
export const zoneTypeOptions = ["重点調査", "商業調査", "再開発候補", "保全", "除外候補"];
export const zoneStatusOptions = ["有効", "確認中", "見直し", "停止", "完了"];
export const landUseOptions = ["商業地", "業務地", "住宅地", "工業地", "公共用地", "雑種地"];
export const buildingUseOptions = ["事務所", "店舗", "住宅", "共同住宅", "倉庫", "工場", "ホテル", "駐車場", "複合用途"];
export const partyTypeOptions = ["法人", "個人", "管理会社", "行政", "金融機関", "士業", "仲介会社"];
export const rightTypeOptions = ["所有権", "借地権", "地上権", "賃借権", "区分所有権", "抵当権"];
export const registrationCauseOptions = ["売買", "合併", "設定", "相続", "贈与", "新築", "保存", "移転", "変更"];
export const buildingStructureOptions = ["S造", "RC造", "SRC造", "木造", "軽量鉄骨造", "CB造"];
export const relationTypeOptions = ["所有者", "売買事業者", "管理者", "借地権者", "賃借人", "仲介", "登記名義人", "連絡先"];

export const emptyBusinessLinks: BusinessLinks = { lands: [], buildings: [] };
