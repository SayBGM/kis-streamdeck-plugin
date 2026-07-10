window.KISStockPI.bootstrap({
  actionTitle: "국내주식 설정",
  fields: [
    {
      id: "instrumentType",
      type: "select",
      label: "상품 유형",
      defaultValue: "stock",
      options: [
        { value: "stock", label: "주식" },
        { value: "etf", label: "ETF/ETN" },
      ],
    },
    {
      id: "stockCode",
      label: "종목코드",
      placeholder: "005930 또는 0210A0",
      help: "6자리 영숫자 종목코드를 입력하세요.",
      errorMessage: "6자리 영숫자를 입력하세요.",
      invalidStatusMessage: "종목코드는 6자리 영숫자여야 합니다.",
      validate: function (value) { return /^[0-9A-Z]{6}$/i.test(value); },
      serialize: function (value) { return value.trim().toUpperCase(); },
    },
    {
      id: "stockName",
      label: "종목명",
      placeholder: "삼성전자",
      serialize: function (value) { return value.trim(); },
    },
  ],
});
