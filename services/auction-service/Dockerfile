FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

COPY ["src/AuctionService/AuctionService.csproj", "AuctionService/"]
RUN dotnet restore "AuctionService/AuctionService.csproj"

COPY src/AuctionService/ AuctionService/
WORKDIR "/src/AuctionService"
RUN dotnet build "AuctionService.csproj" -c Release -o /app/build
RUN dotnet publish "AuctionService.csproj" -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS final
WORKDIR /app
COPY --from=build /app/publish .
EXPOSE 8080
EXPOSE 5000
ENTRYPOINT ["dotnet", "AuctionService.dll"]

