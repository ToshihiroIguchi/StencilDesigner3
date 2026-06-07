// ブランディングおよびファイル出力の設定を管理するモジュール

export interface AppConfig {
  appName: string;
  tabTitleTemplate: string;
  defaultFilename: string;
}

// デフォルト値の定義
export const DEFAULT_CONFIG: AppConfig = {
  appName: 'StencilDesigner3',
  tabTitleTemplate: '{docName} - {appName}',
  defaultFilename: 'stencil',
};

// アプリケーション全体で参照する設定オブジェクトの本体
export let config: AppConfig = { ...DEFAULT_CONFIG };

/**
 * アプリケーション名をファイル名として安全な文字列にサニタイズして変換するヘルパー関数
 */
function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // 英数字以外をハイフンに置換
    .replace(/(^-|-$)/g, '');    // 先頭と末尾のハイフンを除去
}

/**
 * 設定ファイル (config.json) を読み込み、未指定の項目を自動導出・補完する
 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const baseUrl = (typeof import.meta.env !== 'undefined' && import.meta.env.BASE_URL) || '/';
    const response = await fetch(`${baseUrl}config.json`);
    if (response.ok) {
      const data = await response.json();
      
      // アプリケーション名が指定されている場合の設定オブジェクト構築
      const appName = data.appName || DEFAULT_CONFIG.appName;
      
      // タブ名テンプレートの自動導出（未指定時は "{docName} - アプリ名"）
      const tabTitleTemplate = data.tabTitleTemplate || `{docName} - ${appName}`;
      
      // デフォルトファイル名の自動導出（未指定時はアプリ名をサニタイズした文字列）
      let defaultFilename = data.defaultFilename;
      if (!defaultFilename) {
        if (data.appName && data.appName !== DEFAULT_CONFIG.appName) {
          defaultFilename = sanitizeFilename(data.appName);
        } else {
          defaultFilename = DEFAULT_CONFIG.defaultFilename;
        }
      }

      config = {
        appName,
        tabTitleTemplate,
        defaultFilename,
      };
    }
  } catch (e) {
    console.warn('config.json の読み込みに失敗しました。デフォルト設定を使用します。', e);
  }
  return config;
}
