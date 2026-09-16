import React from "react";
import { BaseEdge, getBezierPath, EdgeProps } from "@xyflow/react";

export const ParticleEdge: React.FC<EdgeProps> = (props) => {
  const [edgePath] = getBezierPath(props);

  return (
    <>
      <BaseEdge path={edgePath} style={{ stroke: "#1f293d", strokeWidth: 3 }} />
      <path
        d={edgePath}
        fill="none"
        stroke="#00f0ff"
        strokeWidth="2"
        strokeDasharray="6, 12"
        className="animate-[dash_1s_linear_infinite]"
      />
    </>
  );
};