FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY ["src/WebSocketGateway/WebSocketGateway.csproj", "src/WebSocketGateway/"]
RUN dotnet restore "src/WebSocketGateway/WebSocketGateway.csproj"

COPY . .
WORKDIR "/src/src/WebSocketGateway"
RUN dotnet build "WebSocketGateway.csproj" -c Release -o /app/build

FROM build AS publish
RUN dotnet publish "WebSocketGateway.csproj" -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app
EXPOSE 5000

COPY --from=publish /app/publish .

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl --fail http://localhost:5000/health || exit 1

ENTRYPOINT ["dotnet", "WebSocketGateway.dll"]


