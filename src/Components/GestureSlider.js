import React, { useState, useEffect, useRef } from "react";
import * as handTrack from "handtrackjs";

const GestureSlider = () => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [currentInput, setCurrentInput] = useState("username");
  const [currentCharIndex, setCurrentCharIndex] = useState(0);
  const [isHandDetected, setIsHandDetected] = useState(false);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const modelRef = useRef(null);

  const alphabetArray = React.useMemo(
    () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()"
        .split("")
        .sort(() => Math.random() - 0.5),
    []
  );

  useEffect(() => {
    const modelParams = {
      flipHorizontal: true,
      maxNumBoxes: 1,
      scoreThreshold: 0.6,
    };

    handTrack.load(modelParams).then((model) => {
      modelRef.current = model;
    });

    handTrack.startVideo(videoRef.current).then((status) => {
      if (status) {
        setInterval(() => detectHand(), 100);
      }
    });
  }, []);

  const detectHand = () => {
    if (modelRef.current && videoRef.current) {
      modelRef.current.detect(videoRef.current).then((predictions) => {
        if (predictions.length > 0) {
          const [x] = predictions[0].bbox;

          setIsHandDetected(true);

          const sliderIndex = Math.floor(
            (x / videoRef.current.videoWidth) * alphabetArray.length
          );
          setCurrentCharIndex(Math.max(0, Math.min(sliderIndex, alphabetArray.length - 1)));
        } else {
          setIsHandDetected(false);
        }
      });
    }
  };

  const addCharacter = () => {
    if (currentInput === "username") {
      setUsername((prev) => prev + alphabetArray[currentCharIndex]);
    } else {
      setPassword((prev) => prev + alphabetArray[currentCharIndex]);
    }
  };

  const switchInput = () => {
    setCurrentInput((prev) => (prev === "username" ? "password" : "username"));
    alert("Now enter your " + (currentInput === "username" ? "password" : "username") + ".");
  };

  const handleSubmit = () => {
    alert(`Submitted! Username: ${username}, Password: ${password}`);
  };

  return (
    <div
      style={{
        textAlign: "center",
        margin: "0 auto",
        maxWidth: "90%",
        padding: "20px",
        backgroundColor: "#f8f9fa",
        boxShadow: "0 4px 8px rgba(0, 0, 0, 0.2)",
        borderRadius: "10px",
      }}
    >
      <h1 style={{ color: "#333", fontSize: "24px", marginBottom: "20px" }}>
        Movement (Hand/head) based Login
      </h1>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div>
          <label style={{ marginRight: "10px", fontWeight: "bold" }}>
            Username :
          </label>
          <input
            type="text"
            value={username}
            readOnly
            style={{
              width: "300px",
              padding: "5px",
              borderRadius: "5px",
              border: "1px solid #ddd",
              textAlign: "center",
            }}
          />
        </div>

        <div style={{ marginTop: "20px" }}>
          <label style={{ marginRight: "10px", fontWeight: "bold" }}>
            Password:
          </label>
          <input
            type="text"
            value={password}
            readOnly
            style={{
              width: "300px",
              padding: "5px",
              borderRadius: "5px",
              border: "1px solid #ddd",
              textAlign: "center",
            }}
          />
        </div>
      </div>

      <div style={{ position: "relative", display: "inline-block", margin: "30px 0" }}>
        <video
          ref={videoRef}
          style={{
            width: "320px",
            height: "180px",
            borderRadius: "10px",
            border: "2px solid #ddd",
          }}
          autoPlay
        ></video>
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "320px",
            height: "180px",
          }}
        ></canvas>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          marginTop: "20px",
          padding: "10px",
          backgroundColor: "#fff",
          borderRadius: "5px",
          border: "1px solid #ddd",
          overflowX: "scroll",
          whiteSpace: "nowrap",
          maxWidth: "600px",
        }}
      >
        {alphabetArray.map((char, index) => (
          <span
            key={index}
            style={{
              fontSize: "18px",
              padding: "5px 10px",
              color: index === currentCharIndex ? "red" : "black",
              textAlign: "center",
            }}
          >
            {char}
          </span>
        ))}
      </div>

      <div style={{ marginTop: "20px" }}>
        <button
          onClick={addCharacter}
          style={{
            marginRight: "10px",
            padding: "10px 20px",
            backgroundColor: "#28a745",
            color: "#fff",
            border: "none",
            borderRadius: "5px",
            cursor: "pointer",
          }}
        >
          Add Character
        </button>
        <button
          onClick={switchInput}
          style={{
            marginRight: "10px",
            padding: "10px 20px",
            backgroundColor: "#007bff",
            color: "#fff",
            border: "none",
            borderRadius: "5px",
            cursor: "pointer",
          }}
        >
          Switch Input
        </button>
        <button
          onClick={handleSubmit}
          style={{
            padding: "10px 20px",
            backgroundColor: "#dc3545",
            color: "#fff",
            border: "none",
            borderRadius: "5px",
            cursor: "pointer",
          }}
        >
          Submit
        </button>
      </div>
    </div>
  );
};

export default GestureSlider;