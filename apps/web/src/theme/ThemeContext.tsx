import React, { createContext, useContext, useState } from "react";

export type ThemeMode = "claude-light" | "github-dark";

interface ThemeTokens {
  bgCanvas: string;
  bgPanel: string;
  bgCard: string;
  border: string;
  borderHover: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
  gridColor: string;
  edgeStroke: string;
  edgeGlow: string;
}

export const themeTokens: Record<ThemeMode, ThemeTokens> = {
  "claude-light": {
    bgCanvas: "#FDFBF7",
    bgPanel: "#F4EFF6",
    bgCard: "#FFFFFF",
    border: "#E7DFD5",
    borderHover: "#D6C7B2",
    textPrimary: "#292524",
    textSecondary: "#78716C",
    accent: "#DA5B2A", // Anthropic Terracotta
    gridColor: "#E7E2D9",
    edgeStroke: "#DA5B2A",
    edgeGlow: "rgba(218, 91, 42, 0.15)",
  },
  "github-dark": {
    bgCanvas: "#0D1117",
    bgPanel: "#161B22",
    bgCard: "#21262D",
    border: "#30363D",
    borderHover: "#8B949E",
    textPrimary: "#F0F6FC",
    textSecondary: "#8B949E",
    accent: "#58A6FF", // GitHub Blue
    gridColor: "#21262D",
    edgeStroke: "#58A6FF",
    edgeGlow: "rgba(88, 166, 255, 0.2)",
  },
};

interface ThemeContextType {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  tokens: ThemeTokens;
}

const ThemeContext = createContext<ThemeContextType>({
  mode: "github-dark",
  setMode: () => {},
  tokens: themeTokens["github-dark"],
});

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setMode] = useState<ThemeMode>("claude-light");
  return (
    <ThemeContext.Provider value={{ mode, setMode, tokens: themeTokens[mode] }}>
      <div className={mode}>{children}</div>
    </ThemeContext.Provider>
  );
};

export const useTheme = () => useContext(ThemeContext);