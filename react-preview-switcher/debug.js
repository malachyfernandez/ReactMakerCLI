#!/usr/bin/env node

console.log("Starting debug...");

try {
  console.log("Loading modules...");
  const blessed = require("blessed");
  const { Command } = require("commander");
  const path = require("path");
  
  console.log("Modules loaded successfully");
  
  console.log("Creating screen...");
  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    dockBorders: true,
    mouse: true,
    title: "Debug Test",
  });
  
  console.log("Screen created successfully");
  
  const box = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    content: "Debug test - Press q to quit",
    border: "line",
    style: {
      border: {
        fg: "cyan",
      },
    },
  });
  
  console.log("Box created successfully");
  
  screen.key(["q", "C-c"], () => {
    console.log("Quitting...");
    screen.destroy();
    process.exit(0);
  });
  
  console.log("Rendering screen...");
  screen.render();
  console.log("Screen rendered successfully");
  
} catch (error) {
  console.error("Error:", error.message);
  console.error("Stack:", error.stack);
  process.exit(1);
}
