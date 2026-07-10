window.KISStockPI.bootstrap({
  actionTitle: "미국주식 설정",
  fields: [
    {
      id: "ticker",
      label: "티커 심볼",
      placeholder: "AAPL",
      errorMessage: "1~6자 영문 티커를 입력하세요.",
      invalidStatusMessage: "티커는 1~6자 영문이어야 합니다.",
      validate: function (value) { return /^[A-Z]{1,6}$/i.test(value); },
      normalizeInput: function (value) { return value.toUpperCase(); },
      normalizeReceived: function (value) { return value.toUpperCase(); },
      serialize: function (value) { return value.trim().toUpperCase(); },
    },
    {
      id: "exchange",
      type: "select",
      label: "거래소",
      defaultValue: "NAS",
      options: [
        { value: "NAS", label: "NASDAQ" },
        { value: "NYS", label: "NYSE" },
        { value: "AMS", label: "AMEX" },
      ],
    },
    {
      id: "stockName",
      label: "종목명",
      placeholder: "Apple",
      serialize: function (value) { return value.trim(); },
    },
  ],
});
